"""Private loopback bridge for personal WhatsApp text conversations."""
import asyncio
import contextlib
import hashlib
import logging
import os
from pathlib import Path
import re
import secrets
import shutil

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from typing import Literal

from app.schemas.communications import CommunicationSettings, CommunicationMessage
from app.services.communication_service import communication_service, CommunicationError
from app.services.storage_service import storage_service

logger = logging.getLogger("uvicorn.error")

# Exit codes emitted by our entrypoint; third-party output stays private.
STARTUP_ERRORS = {
    20: "No se pudieron cargar las dependencias de WhatsApp. Despliega la última versión en Render.",
    21: "Falta la clave de la sesión guardada de WhatsApp. Recupera la copia completa de GitHub; no borres la sesión.",
    22: "La clave de la sesión guardada de WhatsApp no es válida. Recupera la copia completa de GitHub; no borres la sesión.",
    23: "No se pudo abrir la sesión cifrada de WhatsApp. Revisa la recuperación de la copia de GitHub; no borres la sesión.",
    24: "WhatsApp no puede acceder a su carpeta de datos. Revisa los permisos de DATA_DIR en el servidor.",
    25: "El puerto interno de WhatsApp está ocupado. Reinicia el servicio de Render y evita arrancar dos conectores en el mismo puerto.",
    26: "WhatsApp no pudo abrir su puerto interno. Revisa WHATSAPP_BRIDGE_PORT y reinicia el servicio.",
    27: "La clave interna del servicio de WhatsApp no es válida. Reinicia el servicio de Render.",
}
PERMANENT_STARTUP_ERRORS = {20, 21, 22, 23, 24, 27}
BRIDGE_STATES = {"disconnected", "connecting", "qr", "connected", "reconnecting", "error"}


class WhatsAppQRSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bot_id: str = Field(min_length=1, max_length=128)
    mode: Literal["self", "separate"] = "self"
    owner_phone_number: str = ""

    @field_validator("owner_phone_number")
    @classmethod
    def phone(cls, value):
        return CommunicationSettings.phone_number(value)

    @model_validator(mode="after")
    def separate_number(self):
        if self.mode == "separate" and not self.owner_phone_number:
            raise ValueError("Introduce tu número con prefijo internacional.")
        if self.mode == "self":
            self.owner_phone_number = ""
        return self


class WhatsAppQRService:
    def __init__(self, storage=storage_service, communications=communication_service):
        self.storage = storage
        self.communications = communications
        self.process = None
        self.task = None
        self.client = None
        self.token = secrets.token_urlsafe(48)
        self.port = int(os.getenv("WHATSAPP_BRIDGE_PORT", "8787"))
        self.available = False
        self.error = ""
        self.restart_count = 0
        self.startup_timeout = 60
        self.exit_reported = False

    def config(self):
        saved = self.storage.get_settings()
        bots = self.storage.get_bots()
        return {
            "enabled": bool(saved.get("whatsapp_qr_enabled", False)),
            "bot_id": saved.get("whatsapp_qr_bot_id") or (bots[0]["id"] if bots else ""),
            "mode": saved.get("whatsapp_qr_mode", "self"),
            "owner_phone_number": saved.get("whatsapp_qr_owner_phone_number", ""),
        }

    async def request(self, method, path, data=None):
        if not self.client or not self.available:
            raise CommunicationError(self.error or "El servicio de WhatsApp está arrancando. Espera unos segundos.")
        try:
            response = await self.client.request(method, path, json=data, timeout=5 if path == "/status" else 20)
            if response.is_error:
                raise CommunicationError("No se pudo completar la operación de WhatsApp. Comprueba la conexión y vuelve a intentarlo.")
            return response.json()
        except (httpx.HTTPError, ValueError) as exc:
            if isinstance(exc, CommunicationError):
                raise
            raise CommunicationError("El servicio de WhatsApp no responde. Espera unos segundos y vuelve a intentarlo.") from None

    async def status(self):
        config = self.config()
        try:
            state = await self.request("GET", "/status")
        except CommunicationError as exc:
            state = {"state": "unavailable", "error": str(exc), "qr": None, "account_phone": ""}
        if config["enabled"] and self.error and not state.get("error"):
            state["error"] = self.error
        return {**state, **config, "available": self.available, "inference_ready": bool(self.storage.get_settings().get("model_api_key")), **self.communications.outbound_budget(qr=True)}

    async def owner_status(self):
        config = self.config()
        if not config["enabled"]:
            return {"enabled": False, "ready": False, "state": "disabled", "error": ""}
        state = await self.status()
        account = state.get("account_phone", "")
        number = account if config["mode"] == "self" else config["owner_phone_number"]
        ready = bool(state.get("available") and state.get("state") == "connected" and state.get("connection_id")
                     and re.fullmatch(r"\+[1-9][0-9]{6,14}", account) and re.fullmatch(r"\+[1-9][0-9]{6,14}", number)
                     and (config["mode"] == "self" or account != number))
        error = state.get("error") or ""
        if not ready and not error:
            if state.get("state") == "connected":
                error = "WhatsApp está vinculado, pero no se pudo identificar la sesión y el destinatario. Despliega la última versión y revisa el modo elegido en Llamadas y WhatsApp."
            else:
                error = "WhatsApp por QR está " + state.get("state", "desconectado") + ". Abre Llamadas y WhatsApp y espera a que indique conectado."
        return {"enabled": True, "ready": ready, "state": state.get("state", "unavailable"), "error": error,
                "mode": config["mode"], "owner_phone_number": number, "account_phone": account,
                "connection_id": state.get("connection_id", ""),
                **{key: state[key] for key in ("daily_outbound_limit", "daily_outbound_used", "daily_outbound_remaining")}}

    async def send_owner(self, data: CommunicationMessage, expected, event_id):
        record_id = "qr-out-" + event_id
        previous = self.communications.record(record_id)
        if previous:
            if previous["payload"].get("bot_id") != data.bot_id or previous["payload"].get("message") != data.message:
                raise CommunicationError("Este envío corresponde a otro mensaje. Solicita el nuevo texto desde el chat.")
            if previous["status"] == "sent":
                return {"id": record_id, "provider_sid": previous["payload"].get("provider_sid"), "provider": "qr", "status": "sent", "note": "Este mensaje ya se envió; no se ha repetido."}
            raise CommunicationError("No se confirmó el envío anterior. Revisa WhatsApp antes de pedir otro mensaje.")
        state = await self.owner_status()
        if not state["ready"]:
            raise CommunicationError(state["error"] or "WhatsApp por QR no está conectado.")
        fields = ("connection_id", "mode", "owner_phone_number", "account_phone")
        if any(state[field] != expected.get(field) for field in fields):
            raise CommunicationError("La conexión o el destinatario de WhatsApp han cambiado. Solicita el envío otra vez.")
        if not self.communications.bot(data.bot_id):
            raise CommunicationError("El Dot seleccionado ya no existe.")
        if not self.communications.claim(record_id, "whatsapp_out", {"bot_id": data.bot_id, "message": data.message, "provider": "qr"}, outbound=True):
            raise CommunicationError("Este envío ya está registrado; no se repetirá.")
        try:
            result = await self.request("POST", "/send-owner", {"id": event_id, "text": data.message, **{field: state[field] for field in fields}})
            if not result.get("id") or result.get("status") != "sent":
                raise CommunicationError("WhatsApp no confirmó el envío. Revisa tu chat antes de volver a pedirlo.")
            self.communications.finish(record_id, "sent", provider_sid=result["id"])
            return {"id": record_id, "provider_sid": result["id"], "provider": "qr", "status": "sent",
                    "note": "WhatsApp ha aceptado el mensaje mediante la sesión QR; la entrega al teléfono todavía no está confirmada."}
        except Exception as exc:
            error = str(exc) if isinstance(exc, CommunicationError) else "No se pudo confirmar el envío por WhatsApp. Revisa tu chat antes de volver a pedirlo."
            self.communications.finish(record_id, "failed", error=error)
            raise CommunicationError(error) from None

    def validate(self, data):
        if not self.communications.bot(data.bot_id):
            raise CommunicationError("El Dot seleccionado ya no existe.")

    async def save(self, data):
        self.validate(data)
        self.storage.save_settings({"whatsapp_qr_" + key: value for key, value in data.model_dump().items()})
        if self.config()["enabled"]:
            await self.request("POST", "/connect", {"mode": data.mode, "owner_phone_number": data.owner_phone_number})
            self.error = ""
        return await self.status()

    async def connect(self, data):
        self.validate(data)
        # Node validates the scope before credentials can be used.
        await self.request("POST", "/connect", {"mode": data.mode, "owner_phone_number": data.owner_phone_number, "renew": True})
        self.error = ""
        self.storage.save_settings({"whatsapp_qr_enabled": True, **{"whatsapp_qr_" + key: value for key, value in data.model_dump().items()}})
        return await self.status()

    async def disconnect(self):
        # Disable before awaiting: an in-flight inference cannot send afterward.
        self.storage.save_settings({"whatsapp_qr_enabled": False})
        await self.request("POST", "/disconnect", {"logout": True})
        return await self.status()

    async def handle(self, event):
        config = self.config()
        event_id = "qr-" + hashlib.sha256(str(event["id"]).encode()).hexdigest()
        if not config["enabled"]:
            await self.request("POST", "/ack", {"id": event["id"]})
            return
        record = self.communications.record(event_id)
        if record:
            if record["status"] == "pending":
                self.communications.finish(event_id, "failed", error="La respuesta se interrumpió al reiniciar el servicio. Escribe de nuevo en WhatsApp.")
            await self.request("POST", "/ack", {"id": event["id"]})
            return
        try:
            self.communications.claim(event_id, "whatsapp_in", {"bot_id": config["bot_id"], "message": event["text"], "provider": "qr"})
        except CommunicationError:
            await self.request("POST", "/ack", {"id": event["id"]})
            return
        try:
            peer_hash = hashlib.sha256(event["peer"].encode()).hexdigest()[:16]
            reply = await self.communications.answer(config["bot_id"], event["text"], "whatsapp-qr-" + config["bot_id"] + "-" + peer_hash)
            if config != self.config():
                raise CommunicationError("La conexión o el Dot han cambiado. Escribe de nuevo en WhatsApp.")
            result = await self.request("POST", "/reply", {"id": event["id"], "text": reply})
            self.communications.finish(event_id, "sent", reply=reply, provider_sid=result["id"])
        except Exception as exc:
            self.communications.finish(event_id, "failed", error=str(exc) if isinstance(exc, CommunicationError) else "La IA no pudo responder. Comprueba NVIDIA y el modelo en Ajustes.")
        await self.request("POST", "/ack", {"id": event["id"]})

    def record_exit(self):
        self.available = False
        code = self.process.returncode
        self.error = STARTUP_ERRORS.get(code, "El servicio de WhatsApp se ha detenido. Reinicia el servicio en Render si no se recupera.")
        if not self.exit_reported:
            logger.warning("WhatsApp private bridge stopped (exit code %s). %s", code, self.error)
            self.exit_reported = True

    async def probe_ready(self):
        if not self.client or not self.process or self.process.returncode is not None:
            return False
        try:
            response = await self.client.get("/status", timeout=1)
            if response.status_code != 200:
                return False
            state = response.json()
            if not isinstance(state, dict) or not isinstance(state.get("state"), str) or state["state"] not in BRIDGE_STATES or not isinstance(state.get("connection_id"), str) or not state["connection_id"]:
                return False
        except (httpx.HTTPError, ValueError):
            return False
        if self.process.returncode is not None:
            return False
        was_available = self.available
        self.available = True
        if not was_available:
            self.error = ""
            logger.info("WhatsApp private bridge ready.")
            if self.config()["enabled"]:
                try:
                    data = WhatsAppQRSettings(**{key: value for key, value in self.config().items() if key != "enabled"})
                    await self.request("POST", "/connect", {"mode": data.mode, "owner_phone_number": data.owner_phone_number})
                except (CommunicationError, ValueError):
                    self.error = "El servicio de WhatsApp está listo, pero no se pudo recuperar la conexión. Pulsa Conectar WhatsApp para intentarlo de nuevo."
                    logger.warning("WhatsApp private bridge ready, but saved connection could not be resumed.")
        return True

    async def wait_ready(self):
        deadline = asyncio.get_running_loop().time() + self.startup_timeout
        while asyncio.get_running_loop().time() < deadline:
            if self.process.returncode is not None:
                self.record_exit()
                return False
            if await self.probe_ready():
                return True
            await asyncio.sleep(0.25)
        self.error = "WhatsApp sigue arrancando. Se comprobará automáticamente; no necesitas volver a escanear el QR mientras se recupera."
        logger.warning("WhatsApp private bridge has not become ready within %s seconds; continuing checks in the background.", self.startup_timeout)
        return False

    async def launch(self):
        # Never spawn another bridge while the previous process is still alive.
        if self.process and self.process.returncode is None:
            return self.available or await self.wait_ready()
        root = Path(__file__).resolve().parents[3]
        script = root / "whatsapp" / "server.mjs"
        if not shutil.which("node") or not (script.parent / "node_modules").is_dir():
            self.error = "Falta instalar el servicio de WhatsApp. Despliega la última versión o ejecuta npm ci en la carpeta whatsapp."
            return False
        environment = {**os.environ, "WHATSAPP_BRIDGE_TOKEN": self.token, "WHATSAPP_BRIDGE_PORT": str(self.port), "DATA_DIR": str(self.storage.data_dir)}
        # libsignal can print complete session objects independently of Pino.
        # Keep third-party stdout/stderr private; report only codes and fixed explanations.
        self.process = await asyncio.create_subprocess_exec("node", str(script), env=environment, cwd=script.parent, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        self.available = False
        self.exit_reported = False
        logger.info("Starting WhatsApp private bridge; allowing up to %s seconds for readiness.", self.startup_timeout)
        return await self.wait_ready()

    async def run(self):
        while True:
            try:
                if self.process and self.process.returncode is not None:
                    self.record_exit()
                    if self.restart_count < 3 and self.process.returncode not in PERMANENT_STARTUP_ERRORS:
                        self.restart_count += 1
                        await asyncio.sleep(self.restart_count)
                        await self.launch()
                elif self.process and not self.available:
                    # A slow but live process can become ready after the initial wait.
                    await self.probe_ready()
                if self.available and self.config()["enabled"]:
                    events = await self.request("GET", "/events")
                    for event in events:
                        await self.handle(event)
            except (CommunicationError, KeyError, TypeError, OSError, ValueError):
                pass
            await asyncio.sleep(1)

    async def start(self):
        if self.task and not self.task.done():
            return
        if os.getenv("WHATSAPP_QR_ENABLED", "1").lower() in {"0", "false"}:
            self.error = "WhatsApp por QR está desactivado en el entorno."
            return
        self.client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{self.port}", headers={"Authorization": "Bearer " + self.token}, timeout=20, trust_env=False)
        try:
            await self.launch()
        except (OSError, ValueError, CommunicationError):
            self.error = "No se pudo arrancar WhatsApp. Revisa los registros del servidor."
        self.task = asyncio.create_task(self.run())

    async def stop(self):
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
        if self.process and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except asyncio.TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self.client:
            await self.client.aclose()
        self.available = False


whatsapp_qr_service = WhatsAppQRService()
