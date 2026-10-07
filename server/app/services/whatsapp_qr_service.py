"""Private loopback bridge for personal WhatsApp text conversations."""
import asyncio
import contextlib
import hashlib
import logging
import os
from pathlib import Path
import secrets
import shutil

import httpx
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from typing import Literal

from app.schemas.communications import CommunicationSettings
from app.services.communication_service import communication_service, CommunicationError
from app.services.storage_service import storage_service

logger = logging.getLogger("uvicorn.error")


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
            response = await self.client.request(method, path, json=data)
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
        return {**state, **config, "available": self.available, "inference_ready": bool(self.storage.get_settings().get("model_api_key"))}

    def validate(self, data):
        if not self.communications.bot(data.bot_id):
            raise CommunicationError("El Dot seleccionado ya no existe.")

    async def save(self, data):
        self.validate(data)
        self.storage.save_settings({"whatsapp_qr_" + key: value for key, value in data.model_dump().items()})
        if self.config()["enabled"]:
            await self.request("POST", "/connect", {"mode": data.mode, "owner_phone_number": data.owner_phone_number})
        return await self.status()

    async def connect(self, data):
        self.validate(data)
        # Node validates the scope before credentials can be used.
        await self.request("POST", "/connect", {"mode": data.mode, "owner_phone_number": data.owner_phone_number, "renew": True})
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

    async def launch(self):
        root = Path(__file__).resolve().parents[3]
        script = root / "whatsapp" / "server.mjs"
        if not shutil.which("node") or not (script.parent / "node_modules").is_dir():
            self.error = "Falta instalar el servicio de WhatsApp. Despliega la última versión o ejecuta npm ci en la carpeta whatsapp."
            return False
        environment = {**os.environ, "WHATSAPP_BRIDGE_TOKEN": self.token, "WHATSAPP_BRIDGE_PORT": str(self.port), "DATA_DIR": str(self.storage.data_dir)}
        # libsignal can print complete session objects independently of Pino.
        # Keep all third-party stdout/stderr private and log only exit codes.
        self.process = await asyncio.create_subprocess_exec("node", str(script), env=environment, cwd=script.parent, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        for _ in range(40):
            if self.process.returncode is not None:
                logger.warning("WhatsApp bridge did not start (exit code %s).", self.process.returncode)
                self.error = "El servicio de WhatsApp no ha arrancado. Revisa los registros del servidor."
                return False
            try:
                response = await self.client.get("/status")
                if response.status_code == 200:
                    self.available = True
                    self.error = ""
                    if self.config()["enabled"]:
                        data = WhatsAppQRSettings(**{key: value for key, value in self.config().items() if key != "enabled"})
                        await self.request("POST", "/connect", {"mode": data.mode, "owner_phone_number": data.owner_phone_number})
                    return True
            except (httpx.HTTPError, ValueError):
                pass
            await asyncio.sleep(0.1)
        self.error = "El servicio de WhatsApp está tardando demasiado en arrancar. Revisa los registros."
        return False

    async def run(self):
        while True:
            try:
                if self.process and self.process.returncode is not None:
                    self.available = False
                    logger.warning("WhatsApp bridge stopped (exit code %s).", self.process.returncode)
                    self.error = "WhatsApp se ha reiniciado. La conexión se está recuperando."
                    if self.restart_count < 3:
                        self.restart_count += 1
                        await self.launch()
                if self.available and self.config()["enabled"]:
                    events = await self.request("GET", "/events")
                    for event in events:
                        await self.handle(event)
            except (CommunicationError, KeyError, TypeError):
                pass
            await asyncio.sleep(1)

    async def start(self):
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
