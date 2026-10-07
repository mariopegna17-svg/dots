"""Reviewed video uploads using YouTube's resumable protocol via Composio."""
import asyncio
import base64
import hashlib
import json
import os
import re
import time
import uuid
from urllib.parse import urlsplit

from app.schemas.youtube import YouTubeMetadata
from app.services.connector_service import connector_service
from app.services.composio_service import ConnectorServiceError
from app.services.storage_service import storage_service

MAX_VIDEO_BYTES = 50 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024  # A multiple of YouTube's required 256 KiB.
VIDEO_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
INTERRUPTED = "Subida interrumpida. Comprueba YouTube Studio antes de volver a subir el vídeo; podría haberse recibido."


def provider_error(result):
    data = result.get("data") or {}
    raw = json.dumps(data).lower()
    if "quotaexceeded" in raw or "dailylimitexceeded" in raw:
        return "YouTube ha alcanzado su cuota de API. Espera o revisa el proyecto de Google en Composio."
    if "uploadlimitexceeded" in raw:
        return "Tu canal ha alcanzado el límite diario de vídeos. YouTube recomienda esperar 24 horas."
    if result.get("status") in {401, 403}:
        return "YouTube ha rechazado el permiso. Desconecta y vuelve a conectar el canal para autorizar la subida."
    return "YouTube no ha aceptado la subida. Comprueba el formato del vídeo y el estado del canal en YouTube Studio."


class YouTubeService:
    def __init__(self, storage=storage_service, connectors=connector_service):
        self.storage = storage
        self.connectors = connectors
        self.directory = storage.data_dir / "youtube-uploads"
        self.directory.mkdir(mode=0o700, exist_ok=True)
        os.chmod(self.directory, 0o700)
        self.workers = set()
        self.cleanup_worker = None
        self.prepare_lock = asyncio.Lock()

    async def channel(self):
        accounts = [a for a in await self.connectors.accounts(["youtube"]) if a.get("status") == "ACTIVE"]
        if not accounts:
            raise ConnectorServiceError("Conecta tu cuenta de YouTube antes de preparar el vídeo.")
        if len(accounts) != 1:
            raise ConnectorServiceError("Hay varias cuentas de YouTube. Desconecta y conecta solo el canal que quieras usar.")
        account = accounts[0]["id"]
        result = await self.connectors.proxy(account, "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true")
        if result.get("status") != 200:
            raise ConnectorServiceError(provider_error(result))
        channels = (result.get("data") or {}).get("items") or []
        if not channels:
            raise ConnectorServiceError("Esta cuenta no tiene un canal. Crea uno en YouTube y vuelve a conectar.")
        if len(channels) != 1:
            raise ConnectorServiceError("Elige un único canal durante la autorización de Google.")
        channel = channels[0]
        return {"account_id": account, "channel_id": channel["id"], "channel_name": (channel.get("snippet") or {}).get("title") or "Tu canal"}

    def list(self):
        with self.storage.database.connect() as db:
            rows = db.execute("SELECT payload FROM tasks WHERE owner_id = ? AND id LIKE 'yt-%' ORDER BY CASE WHEN status IN ('ready','uploading') THEN 0 ELSE 1 END, rowid DESC LIMIT 20", (self.storage.owner_id,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def get(self, upload_id):
        if not re.fullmatch(r"yt-[a-f0-9]{32}", upload_id):
            raise ConnectorServiceError("Borrador de vídeo no encontrado.")
        with self.storage.database.connect() as db:
            row = db.execute("SELECT payload FROM tasks WHERE id = ? AND owner_id = ?", (upload_id, self.storage.owner_id)).fetchone()
        if not row:
            raise ConnectorServiceError("Borrador de vídeo no encontrado.")
        return json.loads(row[0])

    @staticmethod
    def public(item):
        return {k: v for k, v in item.items() if k not in {"account_id", "key_fingerprint"}}

    def save(self, item):
        with self.storage.database.connect() as db:
            db.execute("INSERT INTO tasks(id, thread_id, status, owner_id, payload) VALUES (?, NULL, ?, ?, ?) "
                       "ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload",
                       (item["id"], item["status"], self.storage.owner_id, json.dumps(item)))
            db.execute("DELETE FROM tasks WHERE owner_id = ? AND id LIKE 'yt-%' AND status NOT IN ('ready','uploading') AND id NOT IN (SELECT id FROM tasks WHERE owner_id = ? AND id LIKE 'yt-%' ORDER BY rowid DESC LIMIT 20)", (self.storage.owner_id, self.storage.owner_id))

    def path(self, item):
        # Only opaque server-generated IDs can choose a file.
        return self.directory / item["id"]

    def fingerprint(self):
        return hashlib.sha256(self.connectors.key().encode()).hexdigest()

    async def prepare(self, file, metadata: YouTubeMetadata):
        filename = (file.filename or "video.mp4").replace("\\", "/").split("/")[-1][:200]
        extension = "." + filename.rsplit(".", 1)[-1].lower()
        mime = VIDEO_TYPES.get(extension)
        if not mime or file.content_type not in {mime, "application/octet-stream", None}:
            raise ConnectorServiceError("Elige un vídeo MP4, MOV o WebM.")
        if file.size is not None and (file.size <= 0 or file.size > MAX_VIDEO_BYTES):
            raise ConnectorServiceError("El vídeo debe pesar entre 1 byte y 50 MB.")
        async with self.prepare_lock:
            self.cleanup()
            if sum(i["status"] in {"ready", "uploading"} for i in self.list()) >= 3:
                raise ConnectorServiceError("Ya hay tres vídeos preparados. Sube o elimina un borrador antes de añadir otro.")
            channel = await self.channel()
            item = {"id": "yt-" + uuid.uuid4().hex, **metadata.model_dump(), **channel,
                    "filename": filename, "mime": mime, "size": 0, "uploaded_bytes": 0,
                    "status": "ready", "created_at": time.time(), "expires_at": time.time() + 3600,
                    "key_fingerprint": self.fingerprint(), "error": "", "url": ""}
            path = self.path(item)
            stored = False
            try:
                with path.open("xb") as output:
                    os.chmod(path, 0o600)
                    while chunk := await file.read(CHUNK_BYTES):
                        item["size"] += len(chunk)
                        if item["size"] > MAX_VIDEO_BYTES:
                            raise ConnectorServiceError("El vídeo supera el máximo de 50 MB.")
                        output.write(chunk)
                if not item["size"]:
                    raise ConnectorServiceError("El archivo de vídeo está vacío.")
                self.save(item)
                stored = True
                return self.public(item)
            finally:
                if not stored:
                    path.unlink(missing_ok=True)

    def cleanup(self):
        for item in self.list():
            if item["status"] == "ready" and item["expires_at"] < time.time():
                item.update(status="expired", error="El borrador ha caducado después de una hora. Selecciona el vídeo de nuevo.")
                self.save(item)
                self.path(item).unlink(missing_ok=True)

    def discard(self, upload_id):
        item = self.get(upload_id)
        if item["status"] == "uploading":
            raise ConnectorServiceError("La subida está en marcha. Espera a que termine.")
        self.path(item).unlink(missing_ok=True)
        with self.storage.database.connect() as db:
            db.execute("DELETE FROM tasks WHERE id = ? AND owner_id = ?", (upload_id, self.storage.owner_id))

    async def publish(self, upload_id):
        self.cleanup()
        item = self.get(upload_id)
        if item["status"] != "ready":
            raise ConnectorServiceError("Este borrador ya se ha enviado o ha caducado. No se volverá a subir automáticamente.")
        channel = await self.channel()
        if item["key_fingerprint"] != self.fingerprint() or any(item[k] != channel[k] for k in ("account_id", "channel_id")):
            raise ConnectorServiceError("La conexión o el canal han cambiado. Prepara y revisa el vídeo de nuevo.")
        if not self.path(item).is_file():
            raise ConnectorServiceError("El archivo ya no está disponible. Selecciona el vídeo de nuevo.")
        with self.storage.database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM tasks WHERE owner_id = ? AND id LIKE 'yt-%' AND status = 'uploading'", (self.storage.owner_id,)).fetchone():
                raise ConnectorServiceError("Ya hay un vídeo subiendo. Espera a que termine.")
            item["status"] = "uploading"
            changed = db.execute("UPDATE tasks SET status = 'uploading', payload = ? WHERE id = ? AND owner_id = ? AND status = 'ready'",
                                 (json.dumps(item), upload_id, self.storage.owner_id)).rowcount
            if not changed:
                raise ConnectorServiceError("Esta subida ya se ha confirmado.")
        self.storage.add_audit_event({"event": "youtube.upload_confirmed", "upload_id": upload_id, "channel_id": item["channel_id"], "privacy": item["privacy"]})
        worker = asyncio.create_task(self.run(item))
        self.workers.add(worker)
        worker.add_done_callback(self.workers.discard)
        return self.public(item)

    async def run(self, item):
        try:
            async with asyncio.timeout(900):
                result = await self.connectors.proxy(item["account_id"],
                    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", "POST",
                    body={"snippet": {"title": item["title"], "description": item["description"]},
                          "status": {"privacyStatus": item["privacy"], "selfDeclaredMadeForKids": item["made_for_kids"]}},
                    parameters=[{"name": n, "value": v, "type": "header"} for n, v in {
                        "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": item["mime"],
                        "X-Upload-Content-Length": str(item["size"])}.items()])
                if result.get("status") not in {200, 201}:
                    raise ConnectorServiceError(provider_error(result))
                location = next((v for k, v in (result.get("headers") or {}).items() if k.lower() == "location"), "")
                parsed = urlsplit(location)
                if parsed.scheme != "https" or parsed.hostname != "www.googleapis.com" or parsed.port not in {None, 443} or parsed.username or parsed.password or parsed.path != "/upload/youtube/v3/videos":
                    raise ConnectorServiceError("YouTube no ha devuelto una sesión de subida válida.")
                offset = 0
                with self.path(item).open("rb") as source:
                    while chunk := source.read(CHUNK_BYTES):
                        if item["key_fingerprint"] != self.fingerprint():
                            raise ConnectorServiceError("La clave de conexión cambió durante la subida. Comprueba YouTube Studio.")
                        end = offset + len(chunk) - 1
                        result = await self.connectors.proxy(item["account_id"], location, "PUT",
                            binary_body={"base64": base64.b64encode(chunk).decode("ascii"), "content_type": item["mime"]},
                            parameters=[{"name": "Content-Range", "value": f"bytes {offset}-{end}/{item['size']}", "type": "header"}])
                        last = end + 1 == item["size"]
                        if not last:
                            received = next((v for k, v in (result.get("headers") or {}).items() if k.lower() == "range"), "")
                            if result.get("status") != 308 or received != f"bytes=0-{end}":
                                raise ConnectorServiceError(provider_error(result))
                        else:
                            data = result.get("data") or {}
                            video_id = data.get("id", "")
                            if result.get("status") not in {200, 201} or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                                raise ConnectorServiceError(provider_error(result))
                            # Display the visibility YouTube actually applied (API projects can force private).
                            actual_privacy = (data.get("status") or {}).get("privacyStatus")
                            item.update(status="completed", video_id=video_id, url="https://www.youtube.com/watch?v=" + video_id,
                                        actual_privacy=actual_privacy if actual_privacy in {"private", "unlisted", "public"} else None)
                        offset = end + 1
                        item["uploaded_bytes"] = offset
                        self.save(item)
        except asyncio.CancelledError:
            item.update(status="interrupted", error=INTERRUPTED)
            self.save(item)
            raise
        except Exception as exc:
            item.update(status="failed", error=str(exc) if isinstance(exc, ConnectorServiceError) else INTERRUPTED)
            self.save(item)
        finally:
            self.path(item).unlink(missing_ok=True)
            self.storage.add_audit_event({"event": "youtube.upload_finished", "upload_id": item["id"], "status": item["status"]})

    async def start(self):
        for item in self.list():
            if item["status"] == "uploading":
                item.update(status="interrupted", error=INTERRUPTED)
                self.save(item)
                self.path(item).unlink(missing_ok=True)
        # Remove abandoned temporary files after an interrupted preparation.
        active = {i["id"] for i in self.list() if i["status"] == "ready"}
        for path in self.directory.iterdir():
            if path.is_file() and path.name not in active:
                path.unlink()
        self.cleanup()
        self.cleanup_worker = asyncio.create_task(self.cleanup_loop())

    async def cleanup_loop(self):
        while True:
            await asyncio.sleep(60)
            self.cleanup()

    async def stop(self):
        workers = list(self.workers) + ([self.cleanup_worker] if self.cleanup_worker else [])
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)


youtube_service = YouTubeService()
