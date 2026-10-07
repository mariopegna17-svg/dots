"""Encrypted, bounded application snapshots on a separate GitHub branch.

This module deliberately has no imports of application settings or services:
restoration must finish before SQLite, encryption keys and WhatsApp are opened.
"""
import asyncio
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time
from urllib.parse import quote
import zipfile

import httpx
from cryptography.fernet import Fernet, InvalidToken

MAGIC = b"DOTS_STATE_V1\n"
MAX_ENCRYPTED = 20 * 1024 * 1024
MAX_UNPACKED = 64 * 1024 * 1024
FILES = {"open-dots.sqlite3", ".encryption.key", ".auth-token", "whatsapp/session.enc", "whatsapp/session.key"}
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")


class BackupError(RuntimeError):
    pass


class GitHubBackup:
    def __init__(self, data_dir, environment=None):
        env = os.environ if environment is None else environment
        self.root = Path(data_dir).resolve()
        self.token = env.get("GITHUB_BACKUP_TOKEN", "").strip()
        self.repository = env.get("GITHUB_BACKUP_REPOSITORY", "").strip()
        self.branch = "dots-data"
        self.filename = "dots-state.enc"
        recovery_key = env.get("DATA_BACKUP_KEY", "").strip()
        self.secret = recovery_key or env.get("APP_AUTH_TOKEN", "").strip()
        errors = []
        if self.token:
            if not REPOSITORY.fullmatch(self.repository) or any(part in {".", ".."} for part in self.repository.split("/")):
                errors.append("GITHUB_BACKUP_REPOSITORY debe tener el formato propietario/repositorio; para esta instalación usa mariopegna17-svg/dots, sin https://github.com/.")
            if len(self.secret) < 32:
                if recovery_key:
                    errors.append("DATA_BACKUP_KEY debe tener al menos 32 caracteres aleatorios. Conserva la clave usada en las copias anteriores.")
                else:
                    errors.append("APP_AUTH_TOKEN falta o tiene menos de 32 caracteres. Conserva tu contraseña de acceso y añade DATA_BACKUP_KEY con al menos 32 caracteres aleatorios en Render → Environment. Si ya tienes una copia, conserva su clave original.")
        self.configuration_error = " ".join(errors)
        # A missing setting must not take down authentication and the web app.
        # Pause all remote operations instead of uploading an unrecoverable copy.
        self.enabled = bool(self.token) and not self.configuration_error
        self.root.mkdir(parents=True, exist_ok=True)
        self.record_path = self.root / ".github-backup.json"
        self.restore_marker = self.root / ".github-restore.json"
        self.sha = None
        self.last_hash = ""
        self.last_success = None
        self.last_upload = 0.0
        self.restored = False
        self.error = self.configuration_error
        self.dirty = threading.Event()
        self.lock = threading.Lock()
        self.worker = None
        self.syncing = False

    def cipher(self):
        secret = self.secret
        if not secret and (self.root / ".auth-token").is_file():
            secret = (self.root / ".auth-token").read_text().strip()
        if len(secret) < 32:
            raise BackupError("Configura DATA_BACKUP_KEY con al menos 32 caracteres aleatorios y conserva esa clave para recuperar las copias.")
        key = base64.urlsafe_b64encode(hashlib.sha256(b"dots-backup-v1\0" + secret.encode()).digest())
        return Fernet(key)

    def request(self, method, path, *, missing=False, raw=False, **kwargs):
        headers = {"Authorization": "Bearer " + self.token, "Accept": "application/vnd.github.raw+json" if raw else "application/vnd.github+json",
                   "X-GitHub-Api-Version": "2022-11-28"}
        try:
            with httpx.Client(timeout=20, follow_redirects=False) as client:
                response = client.request(method, "https://api.github.com/repos/" + self.repository + path, headers=headers, **kwargs)
            if missing and response.status_code == 404:
                return None
            if response.status_code in {409, 422}:
                raise BackupError("GitHub tiene otra versión o rechazó la actualización. La copia existente se conserva; revisa que solo haya una instancia de Dots.")
            if response.status_code in {401, 403, 404}:
                raise BackupError("GitHub rechazó el acceso. Revisa el repositorio y el permiso Contents: Read and write del token.")
            if response.status_code == 429:
                raise BackupError("GitHub ha limitado las copias. Se volverá a intentar automáticamente.")
            response.raise_for_status()
            if len(response.content) > MAX_ENCRYPTED * 2:
                raise BackupError("La respuesta de GitHub supera el límite de la copia.")
            return response.content if raw else response.json()
        except BackupError:
            raise
        except (httpx.HTTPError, ValueError) as exc:
            raise BackupError("No se pudo acceder a la copia de GitHub. Se conservan los datos locales y la copia anterior.") from exc

    @staticmethod
    def allowed(name):
        path = Path(name)
        return name in FILES or (name.startswith("workspace/") and path.as_posix() == name and not path.is_absolute() and ".." not in path.parts and "\\" not in name)

    def capture(self):
        database = self.root / "open-dots.sqlite3"
        if not database.is_file() or database.is_symlink():
            raise BackupError("La base de datos todavía no está preparada.")
        files = {}
        with tempfile.TemporaryDirectory(prefix="dots-snapshot-") as directory:
            snapshot = Path(directory) / "database.sqlite3"
            with sqlite3.connect(f"file:{quote(str(database), safe='/')}?mode=ro", uri=True, timeout=20) as source:
                with sqlite3.connect(snapshot) as target:
                    source.backup(target)
            files["open-dots.sqlite3"] = snapshot.read_bytes()
        for name in sorted(FILES - {"open-dots.sqlite3"}):
            path = self.root / name
            if path.is_file() and not path.is_symlink() and self.root in path.resolve().parents:
                files[name] = path.read_bytes()
        workspace = self.root / "workspace"
        if workspace.is_dir() and not workspace.is_symlink():
            for path in sorted(workspace.rglob("*")):
                if path.is_file() and not path.is_symlink() and self.root in path.resolve().parents:
                    if len(files) >= 1000 or path.stat().st_size > 1024 * 1024:
                        raise BackupError("La copia admite hasta 1000 archivos y archivos de trabajo de hasta 1 MB.")
                    files[path.relative_to(self.root).as_posix()] = path.read_bytes()
        if sum(map(len, files.values())) > MAX_UNPACKED:
            raise BackupError("Los datos superan el máximo de 64 MB de la copia de GitHub.")
        if "whatsapp/session.enc" in files and "whatsapp/session.key" not in files:
            raise BackupError("Falta la clave de la sesión de WhatsApp. No se sustituirá la copia anterior.")
        if ".encryption.key" not in files and not os.getenv("APP_ENCRYPTION_KEY"):
            raise BackupError("Falta la clave de cifrado local. No se sustituirá la copia anterior.")
        manifest = {"version": 1, "files": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
        manifest_bytes = json.dumps(manifest, sort_keys=True).encode()
        if len(manifest_bytes) > 200000:
            raise BackupError("El índice de archivos supera el límite de la copia.")
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name)
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
            archive.writestr(zipfile.ZipInfo("manifest.json"), manifest_bytes)
        payload = buffer.getvalue()
        return payload, hashlib.sha256(payload).hexdigest()

    def encrypt(self, payload):
        encrypted = MAGIC + self.cipher().encrypt(payload)
        if len(encrypted) > MAX_ENCRYPTED:
            raise BackupError("La copia cifrada supera el máximo de 20 MB. La copia anterior se conserva.")
        return encrypted

    def unpack(self, encrypted):
        if not encrypted.startswith(MAGIC) or len(encrypted) > MAX_ENCRYPTED:
            raise BackupError("El archivo no es una copia de Dots válida.")
        try:
            payload = self.cipher().decrypt(encrypted[len(MAGIC):])
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                entries = archive.infolist()
                names = [entry.filename for entry in entries]
                if len(names) != len(set(names)) or len(names) > 1001 or sum(entry.file_size for entry in entries) > MAX_UNPACKED + 200000:
                    raise BackupError("El contenido de la copia supera los límites permitidos.")
                if any(name != "manifest.json" and not self.allowed(name) for name in names):
                    raise BackupError("La copia contiene rutas no permitidas.")
                manifest = json.loads(archive.read("manifest.json"))
                if manifest.get("version") != 1 or set(manifest.get("files", {})) != set(names) - {"manifest.json"}:
                    raise BackupError("El índice de la copia no es válido.")
                files = {name: archive.read(name) for name in manifest["files"]}
                if any(hashlib.sha256(data).hexdigest() != manifest["files"][name] for name, data in files.items()):
                    raise BackupError("La copia tiene archivos dañados.")
                if "open-dots.sqlite3" not in files or ("whatsapp/session.enc" in files and "whatsapp/session.key" not in files):
                    raise BackupError("La copia no contiene todos los datos necesarios.")
                if ".encryption.key" not in files and not os.getenv("APP_ENCRYPTION_KEY"):
                    raise BackupError("Falta la clave de cifrado en la copia.")
            return files, hashlib.sha256(payload).hexdigest()
        except BackupError:
            raise
        except (InvalidToken, ValueError, KeyError, TypeError, zipfile.BadZipFile, RuntimeError) as exc:
            raise BackupError("No se pudo descifrar o verificar la copia. Conserva la misma clave de recuperación; no se crearán datos vacíos encima.") from exc

    def write_record(self):
        record = {"sha": self.sha, "hash": self.last_hash, "last_success": self.last_success}
        temporary = self.record_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(record))
        os.chmod(temporary, 0o600)
        temporary.replace(self.record_path)

    def bootstrap(self):
        if not self.enabled:
            return
        meta = self.request("GET", "/contents/" + self.filename, params={"ref": self.branch}, missing=True)
        if meta is None:
            # Distinguish a new branch from an inaccessible repository.
            self.request("GET", "")
            self.dirty.set()
            return
        if meta.get("size", 0) > MAX_ENCRYPTED or not re.fullmatch(r"[0-9a-f]{40}", meta.get("sha", "")):
            raise BackupError("GitHub devolvió una copia demasiado grande o no válida.")
        if meta.get("encoding") == "base64":
            try:
                encrypted = base64.b64decode(meta["content"])
            except (ValueError, KeyError) as exc:
                raise BackupError("La copia de GitHub no es válida.") from exc
        else:
            encrypted = self.request("GET", "/git/blobs/" + meta["sha"], raw=True)
        files, digest = self.unpack(encrypted)
        self.sha = meta["sha"]
        try:
            interrupted_restore = json.loads(self.restore_marker.read_text()).get("sha") == self.sha
        except (OSError, ValueError):
            interrupted_restore = False
        if (self.root / "open-dots.sqlite3").exists() and not interrupted_restore:
            try:
                record = json.loads(self.record_path.read_text())
            except (OSError, ValueError):
                record = {}
            if record.get("sha") != self.sha:
                raise BackupError("Hay datos locales y una copia diferente en GitHub. No se sobrescribirán automáticamente; conserva primero una copia local.")
            self.last_success = record.get("last_success")
            self.dirty.set()
            return
        with tempfile.TemporaryDirectory(prefix="dots-restore-", dir=self.root) as directory:
            stage = Path(directory)
            for name, data in files.items():
                path = stage / name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                path.write_bytes(data)
                os.chmod(path, 0o600)
            with sqlite3.connect(stage / "open-dots.sqlite3") as db:
                if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise BackupError("La base de datos de la copia no está íntegra.")
            for name in files:
                destination = self.root / name
                if destination.is_symlink() or self.root not in destination.resolve().parents:
                    raise BackupError("La ruta local de restauración no es válida.")
            self.restore_marker.write_text(json.dumps({"sha": self.sha}))
            os.chmod(self.restore_marker, 0o600)
            for name in files:
                destination = self.root / name
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                (stage / name).replace(destination)
        self.last_hash = digest
        self.restored = True
        self.last_success = datetime.now(timezone.utc).isoformat()
        self.write_record()
        self.restore_marker.unlink(missing_ok=True)

    def ensure_branch(self):
        branch = self.request("GET", "/git/ref/heads/" + self.branch, missing=True)
        if branch is None:
            repo = self.request("GET", "")
            default = quote(repo.get("default_branch", "main"), safe="")
            head = self.request("GET", "/git/ref/heads/" + default)
            self.request("POST", "/git/refs", json={"ref": "refs/heads/" + self.branch, "sha": head["object"]["sha"]})

    def sync(self):
        if not self.enabled:
            raise BackupError(self.configuration_error or "Configura GITHUB_BACKUP_TOKEN y GITHUB_BACKUP_REPOSITORY en Render para activar el guardado en GitHub.")
        with self.lock:
            self.syncing = True
            # New changes during capture/upload must remain pending.
            self.dirty.clear()
            try:
                payload, digest = self.capture()
                if digest == self.last_hash:
                    self.error = ""
                    return self.status()
                encrypted = self.encrypt(payload)
                if not self.sha:
                    self.ensure_branch()
                body = {"message": "Save encrypted Dots state", "branch": self.branch, "content": base64.b64encode(encrypted).decode("ascii")}
                if self.sha:
                    body["sha"] = self.sha
                result = self.request("PUT", "/contents/" + self.filename, json=body)
                next_sha = (result.get("content") or {}).get("sha", "")
                if not re.fullmatch(r"[0-9a-f]{40}", next_sha):
                    raise BackupError("GitHub no confirmó la copia. Comprueba la rama dots-data antes de volver a guardar.")
                self.sha, self.last_hash = next_sha, digest
                self.last_success = datetime.now(timezone.utc).isoformat()
                self.last_upload = time.monotonic()
                self.error = ""
                self.write_record()
                return self.status()
            except BackupError as exc:
                self.dirty.set()
                self.error = str(exc)
                raise
            except Exception as exc:
                self.dirty.set()
                self.error = "La copia no se completó. Se conservan los datos locales y la copia anterior."
                raise BackupError(self.error) from exc
            finally:
                self.syncing = False

    def status(self):
        return {"configured": self.enabled, "repository": self.repository if self.enabled else "", "branch": self.branch,
            "restored": self.restored, "last_success": self.last_success, "pending": self.dirty.is_set(),
            "syncing": self.syncing, "error": self.error,
            "message": self.configuration_error or ("Copia cifrada automática; la clave de recuperación permanece fuera de GitHub." if self.enabled else "Los datos están en el disco local. Activa la copia de GitHub para recuperarlos si Render borra ese disco.")}

    async def loop(self):
        while True:
            await asyncio.sleep(5)
            if time.monotonic() - self.last_upload >= 30:
                try:
                    await asyncio.to_thread(self.sync)
                except BackupError:
                    # Keep errors in the owner-only status, never log credentials.
                    self.last_upload = time.monotonic()

    async def start(self):
        if not self.enabled:
            return
        try:
            await asyncio.to_thread(self.sync)
        except BackupError:
            self.last_upload = time.monotonic()
        self.worker = asyncio.create_task(self.loop())

    async def stop(self):
        if not self.enabled:
            return
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
        try:
            await asyncio.to_thread(self.sync)
        except BackupError:
            pass


backup_service = None


def configure_backup(data_dir):
    global backup_service
    backup_service = GitHubBackup(data_dir)
    if backup_service.configuration_error:
        logging.getLogger(__name__).warning("Copias de GitHub pausadas: %s", backup_service.configuration_error)
    backup_service.bootstrap()


def mark_changed(database_path):
    if backup_service and Path(database_path).resolve() == backup_service.root / "open-dots.sqlite3":
        backup_service.dirty.set()
