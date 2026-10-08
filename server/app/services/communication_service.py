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
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code


def provider_error(code):
    messages = {
        11200: "Twilio no pudo abrir el webhook de esta web. Revisa la URL HTTPS y los registros de Render; si el servicio está dormido, abre la web antes de probar.",
        11205: "Twilio no pudo conectar con el servidor del webhook. Comprueba que la web esté accesible en su URL HTTPS.",
        12300: "El webhook devolvió un contenido que Twilio no reconoce. Revisa la URL pública y despliega la versión actual de Dots.",
        20003: "Twilio no acepta el Account SID o el Auth Token. Usa las credenciales de producción de la misma cuenta, no las credenciales de prueba de la API.",
        20005: "La cuenta de Twilio no está activa. Revisa su estado en Twilio Console.",
        21211: "Twilio no reconoce el número de destino. Revisa tu número con prefijo internacional.",
        21212: "El número de origen no sirve para llamadas. Usa un número de voz de tu cuenta de Twilio o un identificador verificado.",
        21210: "Verifica el número de origen de la llamada en Twilio o usa un número de voz de esa cuenta.",
        21215: "Twilio tiene bloqueadas las llamadas a ese país. Actívalo en Voice → Geo Permissions.",
        21219: "Tu cuenta de prueba solo puede llamar a números verificados. Verifica tu teléfono en Twilio → Verified Caller IDs.",
        21606: "El remitente no permite enviar mensajes. Revisa el número de WhatsApp de Twilio.",
        21608: "Tu cuenta de prueba necesita que verifiques el número de destino en Twilio.",
        63007: "El remitente de WhatsApp no está registrado en esta cuenta. Usa el número exacto del Sandbox o un remitente aprobado.",
        63015: "Tu teléfono no está unido al Sandbox de WhatsApp. Envía el código join que aparece en Twilio desde tu WhatsApp y vuelve a intentarlo.",
        63016: "Abre la conversación enviando primero un WhatsApp al número de Twilio. Fuera de 24 horas se necesita una plantilla aprobada.",
        63024: "El número de destino no está disponible en WhatsApp. Revisa tu número configurado.",
    }
    text = messages.get(code, "Twilio rechazó la solicitud. Revisa el número, los permisos y el saldo en Twilio Console.")
    return f"Twilio {code}: {text}" if code else text


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

    def raw_config(self):
        public_url = (os.getenv("COMMUNICATION_PUBLIC_URL") or os.getenv("PUBLIC_APP_URL") or os.getenv("RENDER_EXTERNAL_URL", "")).strip()
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
        # A blank saved URL must not erase Render's automatically supplied origin.
        defaults["communication_public_url"] = defaults["communication_public_url"] or public_url
        bots = self.storage.get_bots()
        defaults["communication_bot_id"] = defaults["communication_bot_id"] or (bots[0]["id"] if bots else "")
        return defaults

    def validated_config(self):
        raw = self.raw_config()
        invalid = {}
        try:
            return CommunicationSettings.model_validate(raw).model_dump(), invalid
        except ValidationError as exc:
            for error in exc.errors(include_input=False, include_context=False, include_url=False):
                field = error["loc"][0]
                invalid[field] = error["msg"].removeprefix("Value error, ")
                raw.pop(field, None)
        return CommunicationSettings.model_validate(raw).model_dump(), invalid

    def config(self):
        return self.validated_config()[0]

    def status(self):
        config, invalid = self.validated_config()
        labels = {"twilio_account_sid": "Account SID de Twilio", "twilio_auth_token": "Auth Token de Twilio", "owner_phone_number": "tu número de teléfono", "communication_public_url": "la URL pública HTTPS de esta web", "twilio_voice_number": "el número de Twilio para llamadas", "twilio_whatsapp_number": "el número del Sandbox o remitente de WhatsApp"}
        common = [invalid[key] if key in invalid else f"Falta {labels[key]}." for key in ("twilio_account_sid", "twilio_auth_token", "owner_phone_number", "communication_public_url") if not config[key]]
        if not config["communications_enabled"]:
            common.append("Activa la conexión en Configurar y guarda los cambios.")
        issues = {}
        for channel, field in [("voice", "twilio_voice_number"), ("whatsapp", "twilio_whatsapp_number")]:
            issues[channel] = list(common)
            if not config[field]:
                issues[channel].append(invalid.get(field) or f"Falta {labels[field]}.")
        if not self.bot(config["communication_bot_id"]):
            issues["whatsapp"].append("Selecciona un Dot que responda por WhatsApp.")
        configured = bool(config["twilio_account_sid"] and config["twilio_auth_token"] and config["owner_phone_number"] and config["communication_public_url"])
        return {
            "voice_ready": not issues["voice"],
            "whatsapp_ready": not issues["whatsapp"],
            "configured": configured,
            "setup_issues": issues,
            "whatsapp_webhook": config["communication_public_url"] + WEBHOOK_ROOT + "/whatsapp" if config["communication_public_url"] else "",
            "daily_outbound_limit": 10,
        }

    def public_config(self):
        config, invalid = self.validated_config()
        raw = self.raw_config()
        config.update({key: raw[key] for key in invalid if key != "twilio_auth_token"})
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
        return [{"id": row["id"], "channel": row["channel"], "status": row["status"], "created_at": row["created_at"], **{key: json.loads(row["payload"]).get(key, "") for key in ("message", "reply", "error", "error_code", "provider")}} for row in rows]

    async def _request(self, method, resource, *, data=None, params=None):
        config = self.config()
        try:
            async with httpx.AsyncClient(timeout=12) as client:
                suffix = f"/{resource}" if resource else ""
                response = await client.request(method, f"https://api.twilio.com/2010-04-01/Accounts/{config['twilio_account_sid']}{suffix}.json", auth=(config["twilio_account_sid"], config["twilio_auth_token"]), data=data, params=params)
            if response.is_error:
                try:
                    code = int(response.json().get("code"))
                except (ValueError, TypeError, AttributeError):
                    code = None
                raise CommunicationError(provider_error(code), code)
            result = response.json()
            if not isinstance(result, dict):
                raise CommunicationError("Twilio devolvió una respuesta inválida. Consulta Twilio Console.")
            return result
        except (httpx.HTTPError, ValueError) as exc:
            if isinstance(exc, CommunicationError):
                raise
            raise CommunicationError("No se pudo confirmar la conexión con Twilio. Consulta su panel antes de reintentar.") from None

    async def _post(self, resource, data):
        result = await self._request("POST", resource, data=data)
        if not result.get("sid"):
            raise CommunicationError("Twilio no confirmó la solicitud.")
        return {"sid": result["sid"], "status": result.get("status", "queued")}

    async def check_connection(self):
        """Read-only checks: never create a call or send a message."""
        config = self.config()
        status = self.status()
        checks = []
        for channel in ("voice", "whatsapp"):
            checks.append({"id": channel, "ok": not status["setup_issues"][channel], "message": "Datos completos." if not status["setup_issues"][channel] else " ".join(status["setup_issues"][channel])})
        if config["twilio_account_sid"] and config["twilio_auth_token"]:
            try:
                account = await self._request("GET", "")
                active = account.get("status") == "active"
                checks.append({"id": "account", "ok": active, "message": "Credenciales de Twilio válidas." if active else "La cuenta de Twilio no está activa. Revisa Twilio Console."})
                if active and config["twilio_voice_number"]:
                    numbers = await self._request("GET", "IncomingPhoneNumbers", params={"PhoneNumber": config["twilio_voice_number"], "PageSize": 20})
                    voice = any(number.get("phone_number") == config["twilio_voice_number"] and number.get("capabilities", {}).get("voice") for number in numbers.get("incoming_phone_numbers", []))
                    if not voice:
                        verified = await self._request("GET", "OutgoingCallerIds", params={"PhoneNumber": config["twilio_voice_number"], "PageSize": 20})
                        voice = any(number.get("phone_number") == config["twilio_voice_number"] for number in verified.get("outgoing_caller_ids", []))
                    checks.append({"id": "voice_number", "ok": voice, "message": "Remitente de voz válido." if voice else "El número de voz no pertenece a esta cuenta ni es un identificador verificado. Revisa el número en Twilio."})
                if active and account.get("type") == "Trial" and config["owner_phone_number"]:
                    numbers = await self._request("GET", "OutgoingCallerIds", params={"PhoneNumber": config["owner_phone_number"], "PageSize": 20})
                    verified = any(number.get("phone_number") == config["owner_phone_number"] for number in numbers.get("outgoing_caller_ids", []))
                    checks.append({"id": "trial_phone", "ok": verified, "message": "Tu teléfono está verificado para la cuenta de prueba." if verified else "Verifica tu teléfono en Twilio → Verified Caller IDs antes de llamar desde la cuenta de prueba."})
            except CommunicationError as exc:
                checks.append({"id": "twilio", "ok": False, "message": str(exc)})
        if config["communication_public_url"]:
            try:
                async with httpx.AsyncClient(timeout=8) as client:
                    response = await client.get(config["communication_public_url"] + "/api/v1/health")
                reachable = response.status_code == 200 and response.json().get("status") == "online"
            except (httpx.HTTPError, ValueError, AttributeError):
                reachable = False
            checks.append({"id": "public_url", "ok": reachable, "message": "La URL pública responde." if reachable else "La URL pública no responde como esta aplicación. Usa el dominio HTTPS de Render, sin /app, y espera a que termine el despliegue."})
        return {"ok": all(item["ok"] for item in checks), "checks": checks, "whatsapp_note": "La entrega de WhatsApp se comprueba al enviar: el teléfono debe estar unido al Sandbox y haber enviado un mensaje en las últimas 24 horas."}

    def status_url(self, event_id, channel):
        return self.config()["communication_public_url"] + WEBHOOK_ROOT + "/status?" + urlencode({"event": event_id, "channel": channel})

    def submitted(self, event_id, result, **updates):
        record = self.record(event_id)
        # Twilio can deliver its callback before the REST request returns.
        self.finish(event_id, "submitted" if record["status"] == "pending" else record["status"], provider_sid=result["sid"], **updates)

    def delivery(self, event_id, sid, status, code=None):
        record = self.record(event_id)
        voice = record["channel"] == "voice_out"
        order = {"pending": -2, "submitted": -1, "queued": 0, "initiated": 0, "ringing": 1, "in-progress": 2, "completed": 3, "busy": 3, "no-answer": 3, "canceled": 3, "failed": 3} if voice else {"pending": -2, "submitted": -1, "accepted": 0, "queued": 0, "sending": 1, "sent": 2, "delivered": 3, "read": 4, "failed": 4, "undelivered": 4}
        if status not in order:
            raise CommunicationError("Estado de Twilio inválido.")
        if order.get(record["status"], -2) >= order[status]:
            return
        updates = {"provider_sid": sid}
        if code:
            updates.update(error=provider_error(code), error_code=code)
        elif status in {"failed", "undelivered"}:
            updates["error"] = "Twilio no pudo completar la entrega. Revisa el registro de esta comunicación en Twilio Console."
        self.finish(event_id, status, **updates)

    def url(self, session, stage="start", turn=0):
        return self.config()["communication_public_url"] + WEBHOOK_ROOT + "/voice?" + urlencode({"session": session, "stage": stage, "turn": turn})

    async def send(self, channel, data):
        if not self.status()["voice_ready" if channel == "voice" else "whatsapp_ready"]:
            raise CommunicationError(" ".join(self.status()["setup_issues"][channel]))
        if not self.bot(data.bot_id):
            raise CommunicationError("El Dot seleccionado ya no existe.")
        config = self.config()
        event_id = uuid.uuid4().hex
        self.claim(event_id, channel + "_out", {"bot_id": data.bot_id, "message": data.message}, outbound=True)
        try:
            if channel == "voice":
                result = await self._post("Calls", {"From": config["twilio_voice_number"], "To": config["owner_phone_number"], "Url": self.url(event_id), "Method": "POST", "TimeLimit": "180", "StatusCallback": self.status_url(event_id, channel), "StatusCallbackMethod": "POST", "StatusCallbackEvent": ["initiated", "ringing", "answered", "completed"]})
            else:
                result = await self._post("Messages", {"From": "whatsapp:" + config["twilio_whatsapp_number"], "To": "whatsapp:" + config["owner_phone_number"], "Body": data.message, "StatusCallback": self.status_url(event_id, channel)})
            self.submitted(event_id, result)
            return {"id": event_id, **result, "note": "Solicitud aceptada por Twilio; todavía no confirma la entrega."}
        except CommunicationError as exc:
            self.finish(event_id, "failed", error=str(exc), error_code=exc.code)
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
            async for event in provider_service.stream_chat_completion(model=bot.get("model") or self.storage.get_settings()["default_model"], messages=history + [{"role": "user", "content": text}], system_prompt=system, response_profile="communication"):
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
            result = await self._post("Messages", {"From": "whatsapp:" + config["twilio_whatsapp_number"], "To": "whatsapp:" + config["owner_phone_number"], "Body": reply, "StatusCallback": self.status_url(event_id, "whatsapp")})
            self.submitted(event_id, result, reply=reply)
        except Exception as exc:
            error = str(exc) if isinstance(exc, CommunicationError) else "El proveedor de IA no pudo responder. Revisa el modelo y su configuración en Ajustes."
            self.finish(event_id, "failed", error=error, error_code=getattr(exc, "code", None))

    async def reply_voice(self, event_id, session, bot_id, text):
        try:
            reply = await self.answer(bot_id, text, "voice-" + session, voice=True)
            self.finish(event_id, "completed", reply=reply)
        except Exception:
            self.finish(event_id, "failed", reply="No he podido responder en este momento. Podemos continuar en la web.")


communication_service = CommunicationService()
