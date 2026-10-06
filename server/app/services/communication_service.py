"""Owner-only Twilio calls and WhatsApp, with signed webhooks and durable deduplication."""
import asyncio
import base64
import hashlib
import hmac
import json
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode
from xml.etree.ElementTree import Element, SubElement, tostring
from pydantic import ValidationError

import httpx

from app.schemas.communications import CommunicationSettings, CommunicationMessage
from app.services.storage_service import storage_service
from app.services.provider_service import provider_service
from app.services.memory_service import memory_service


WEBHOOK_ROOT = "/api/v1/communications/webhooks"
SETTING_FIELDS = set(CommunicationSettings.model_fields) - {"twilio_auth_token_configured"}


class CommunicationError(ValueError):
    pass


def verify_signature(url, params, token, signature):
    """Twilio's form webhook signature: URL + sorted keys and distinct values."""
    if not token or not signature:
        return False
    text = url
    for key in sorted(set(params.keys())):
        values = params.getlist(key) if hasattr(params, "getlist") else [params[key]]
        for value in sorted(set(values)):
            text += key + value
    expected = base64.b64encode(hmac.new(token.encode(), text.encode(), hashlib.sha1).digest()).decode()
    return hmac.compare_digest(expected, signature)


def twiml(text=None, *, gather_url=None, redirect_url=None, hangup=False):
    root = Element("Response")
    parent = root
    if gather_url:
        parent = SubElement(root, "Gather", input="speech", language="es-ES", speechTimeout="auto", timeout="8", action=gather_url, method="POST")
    if text:
        SubElement(parent, "Say", language="es-ES", voice="Polly.Conchita").text = text
    if redirect_url:
        SubElement(root, "Pause", length="2")
        SubElement(root, "Redirect", method="POST").text = redirect_url
    if hangup or gather_url:
        SubElement(root, "Hangup")
    return tostring(root, encoding="unicode")


class CommunicationService:
    def __init__(self, storage=storage_service):
        self.storage = storage

    def config(self):
        public_url = os.getenv("COMMUNICATION_PUBLIC_URL") or os.getenv("PUBLIC_APP_URL") or os.getenv("RENDER_EXTERNAL_URL", "")
        if not public_url.startswith("https://"):
            public_url = ""
        defaults = {
            "communications_enabled": os.getenv("COMMUNICATIONS_ENABLED", "0").lower() in {"1", "true", "yes"},
            "twilio_account_sid": os.getenv("TWILIO_ACCOUNT_SID", ""),
            "twilio_auth_token": os.getenv("TWILIO_AUTH_TOKEN", ""),
            "owner_phone_number": os.getenv("OWNER_PHONE_NUMBER", ""),
            "twilio_voice_number": os.getenv("TWILIO_VOICE_NUMBER", ""),
            "twilio_whatsapp_number": os.getenv("TWILIO_WHATSAPP_NUMBER", ""),
            "communication_bot_id": os.getenv("COMMUNICATION_BOT_ID", ""),
            "communication_public_url": public_url,
        }
        saved = self.storage.get_settings()
        defaults.update({key: saved[key] for key in SETTING_FIELDS if key in saved})
        return CommunicationSettings.model_validate(defaults).model_dump()

    def status(self):
        try:
            config = self.config()
        except ValidationError:
            return {"voice_ready": False, "whatsapp_ready": False, "configured": False, "whatsapp_webhook": "", "daily_outbound_limit": 10}
        configured = bool(config["twilio_account_sid"] and config["twilio_auth_token"] and config["owner_phone_number"] and config["communication_public_url"])
        active = configured and config["communications_enabled"]
        return {
            "voice_ready": bool(active and config["twilio_voice_number"]),
            "whatsapp_ready": bool(active and config["twilio_whatsapp_number"]),
            "configured": configured,
            "whatsapp_webhook": config["communication_public_url"] + WEBHOOK_ROOT + "/whatsapp" if config["communication_public_url"] else "",
            "daily_outbound_limit": 10,
        }

    def public_config(self):
        config = self.config()
        config["twilio_auth_token_configured"] = bool(config["twilio_auth_token"])
        config["twilio_auth_token"] = ""
        return {**config, **self.status()}

    def save_config(self, data):
        values = data.model_dump(exclude_unset=True)
        if values.get("communication_bot_id") and not self.bot(values["communication_bot_id"]):
            raise CommunicationError("El Dot seleccionado ya no existe.")
        self.storage.save_settings({k: v for k, v in values.items() if k in SETTING_FIELDS})
        return self.public_config()

    def bot(self, bot_id):
        return next((bot for bot in self.storage.get_bots() if bot["id"] == bot_id), None)

    def record(self, event_id):
        with self.storage.database.connect() as db:
            row = db.execute("SELECT * FROM communication_events WHERE id = ? AND owner_id = ?", (event_id, self.storage.owner_id)).fetchone()
        return {**dict(row), "payload": json.loads(row["payload"])} if row else None

    def claim(self, event_id, channel, payload, *, outbound=False):
        now = datetime.now(timezone.utc).isoformat()
        with self.storage.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM communication_events WHERE id = ?", (event_id,)).fetchone():
                return False
            channels = ("voice_out", "whatsapp_out") if outbound else ("voice_turn", "whatsapp_in")
            count = db.execute("SELECT COUNT(*) FROM communication_events WHERE owner_id = ? AND created_at >= ? AND channel IN (?, ?)", (self.storage.owner_id, now[:10], *channels)).fetchone()[0]
            if count >= (10 if outbound else 40):
                raise CommunicationError("Se ha alcanzado el límite diario de comunicaciones.")
            db.execute("INSERT INTO communication_events(id, owner_id, channel, status, created_at, payload) VALUES (?, ?, ?, 'pending', ?, ?)", (event_id, self.storage.owner_id, channel, now, json.dumps(payload)))
        return True

    def finish(self, event_id, status, **updates):
        with self.storage.database.connect() as db:
            row = db.execute("SELECT payload FROM communication_events WHERE id = ? AND owner_id = ?", (event_id, self.storage.owner_id)).fetchone()
            if row:
                payload = {**json.loads(row[0]), **updates}
                db.execute("UPDATE communication_events SET status = ?, payload = ? WHERE id = ? AND owner_id = ?", (status, json.dumps(payload), event_id, self.storage.owner_id))

    def recent(self):
        with self.storage.database.connect() as db:
            rows = db.execute("SELECT id, channel, status, created_at, payload FROM communication_events WHERE owner_id = ? AND channel IN ('voice_out','whatsapp_out','whatsapp_in') ORDER BY created_at DESC LIMIT 20", (self.storage.owner_id,)).fetchall()
        return [{"id": row["id"], "channel": row["channel"], "status": row["status"], "created_at": row["created_at"], "message": json.loads(row["payload"]).get("message", ""), "reply": json.loads(row["payload"]).get("reply", "")} for row in rows]

    async def _post(self, resource, data):
        config = self.config()
        try:
            async with httpx.AsyncClient(timeout=12) as client:
                response = await client.post(f"https://api.twilio.com/2010-04-01/Accounts/{config['twilio_account_sid']}/{resource}.json", auth=(config["twilio_account_sid"], config["twilio_auth_token"]), data=data)
            if response.is_error:
                code = response.json().get("code")
                if code == 63016:
                    raise CommunicationError("Abre la conversación enviando primero un WhatsApp al número de Twilio. Fuera de 24 horas se necesita una plantilla aprobada.")
                raise CommunicationError("Twilio rechazó la solicitud. Revisa las credenciales, el número, la verificación y el saldo en su panel.")
            result = response.json()
            if not result.get("sid"):
                raise CommunicationError("Twilio no confirmó la solicitud.")
            return {"sid": result["sid"], "status": result.get("status", "queued")}
        except (httpx.HTTPError, ValueError) as exc:
            if isinstance(exc, CommunicationError):
                raise
            raise CommunicationError("No se pudo confirmar la conexión con Twilio. Consulta su panel antes de reintentar.") from None

    def url(self, session, stage="start", turn=0):
        return self.config()["communication_public_url"] + WEBHOOK_ROOT + "/voice?" + urlencode({"session": session, "stage": stage, "turn": turn})

    async def send(self, channel, data):
        if not self.status()["voice_ready" if channel == "voice" else "whatsapp_ready"]:
            raise CommunicationError("Completa y activa la conexión con Twilio en Llamadas y WhatsApp.")
        if not self.bot(data.bot_id):
            raise CommunicationError("El Dot seleccionado ya no existe.")
        config = self.config()
        event_id = uuid.uuid4().hex
        self.claim(event_id, channel + "_out", {"bot_id": data.bot_id, "message": data.message}, outbound=True)
        try:
            if channel == "voice":
                result = await self._post("Calls", {"From": config["twilio_voice_number"], "To": config["owner_phone_number"], "Url": self.url(event_id), "Method": "POST", "TimeLimit": "180"})
            else:
                result = await self._post("Messages", {"From": "whatsapp:" + config["twilio_whatsapp_number"], "To": "whatsapp:" + config["owner_phone_number"], "Body": data.message})
            self.finish(event_id, "submitted", provider_sid=result["sid"])
            return {"id": event_id, **result, "note": "Solicitud aceptada por Twilio; todavía no confirma la entrega."}
        except CommunicationError:
            self.finish(event_id, "failed")
            raise

    async def answer(self, bot_id, text, thread_id, *, voice=False):
        bot = self.bot(bot_id)
        if not bot:
            raise CommunicationError("El Dot ya no existe.")
        history = [{"role": "user" if item["sender"] == "user" else "assistant", "content": item["text"]} for item in self.storage.get_messages(thread_id)[-8:]]
        system = bot.get("system_prompt", "") + memory_service.context(bot_id)
        system += "\nResponde en español de forma breve y natural. Estás hablando con el propietario por " + ("teléfono. Máximo dos frases, sin Markdown." if voice else "WhatsApp. Usa texto sencillo.")
        system += " No tienes herramientas en este canal. No afirmes ejecutar acciones, enviar mensajes ni crear rutinas."
        response = ""
        success = False
        async def generate():
            nonlocal response, success
            async for event in provider_service.stream_chat_completion(model=bot.get("model") or self.storage.get_settings()["default_model"], messages=history + [{"role": "user", "content": text}], system_prompt=system):
                if event["type"] == "content.delta":
                    response += event["delta"]
                elif event["type"] == "turn.completed":
                    success = event.get("ok", False)
        await asyncio.wait_for(generate(), timeout=25)
        if not success or not response.strip():
            raise CommunicationError("El proveedor de IA no pudo responder.")
        response = response.strip()[:800 if voice else 1500]
        for sender, content in [("user", text), ("bot", response)]:
            self.storage.add_message({"id": uuid.uuid4().hex, "thread_id": thread_id, "bot_id": bot_id, "sender": sender, "text": content, "created_at": datetime.now(timezone.utc).isoformat()})
        return response

    async def reply_whatsapp(self, event_id, bot_id, text):
        try:
            reply = await self.answer(bot_id, text, "whatsapp-" + bot_id)
            config = self.config()
            # Re-check enabled state after inference, before any external effect.
            if not self.status()["whatsapp_ready"]:
                raise CommunicationError("La conexión está desactivada.")
            result = await self._post("Messages", {"From": "whatsapp:" + config["twilio_whatsapp_number"], "To": "whatsapp:" + config["owner_phone_number"], "Body": reply})
            self.finish(event_id, "submitted", reply=reply, provider_sid=result["sid"])
        except Exception:
            self.finish(event_id, "failed")

    async def reply_voice(self, event_id, session, bot_id, text):
        try:
            reply = await self.answer(bot_id, text, "voice-" + session, voice=True)
            self.finish(event_id, "completed", reply=reply)
        except Exception:
            self.finish(event_id, "failed", reply="No he podido responder en este momento. Podemos continuar en la web.")


communication_service = CommunicationService()
