"""Owner-scoped Composio connections; credentials stay on the server."""
import re
import uuid
from urllib.parse import urlsplit

import httpx

from app.services.composio_service import ConnectorServiceError, composio_service
from app.services.storage_service import storage_service

BACKEND_URL = "https://backend.composio.dev/api/v3"
SAFE_SLUG = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class ConnectorService:
    def __init__(self, storage=storage_service):
        self.storage = storage

    def key(self):
        return composio_service.get_api_key() if self.storage is storage_service else str(self.storage.get_settings().get("composio_api_key") or "")

    def user_id(self):
        # Unique per installation, even when several installations share a project.
        with self.storage.database.connect() as db:
            db.execute("INSERT OR IGNORE INTO storage_meta(key, value) VALUES (?, ?)",
                       ("connector_user_id", "dots_" + uuid.uuid4().hex))
            return db.execute("SELECT value FROM storage_meta WHERE key = 'connector_user_id'").fetchone()[0]

    @staticmethod
    def validate_slug(slug):
        if not SAFE_SLUG.fullmatch(slug):
            raise ConnectorServiceError("El nombre del conector no es válido.")
        return slug

    async def request(self, method, path, *, key=None, **kwargs):
        key = key or self.key()
        if not key:
            raise ConnectorServiceError("Primero guarda tu clave de Composio en Conectores.")
        try:
            async with httpx.AsyncClient(timeout=60, follow_redirects=False) as client:
                response = await client.request(method, BACKEND_URL + path, headers={"x-api-key": key}, **kwargs)
                if response.status_code in {401, 403}:
                    raise ConnectorServiceError("Composio ha rechazado la clave o el permiso. Revisa la configuración del proyecto.")
                if response.status_code == 429:
                    raise ConnectorServiceError("Se ha alcanzado la cuota de Composio. Espera o revisa tu plan.")
                response.raise_for_status()
                return response.json() if response.content else {}
        except (httpx.HTTPError, ValueError) as exc:
            if isinstance(exc, ConnectorServiceError):
                raise
            raise ConnectorServiceError("No se pudo completar la conexión con Composio. Vuelve a intentarlo.") from exc

    async def accounts(self, slugs=None):
        for slug in slugs or []:
            self.validate_slug(slug)
        owner = self.user_id()
        params = {"user_ids": [owner], "limit": 100}
        if slugs is not None:
            params["toolkit_slugs"] = slugs
        accounts = []
        for _ in range(10):
            result = await self.request("GET", "/connected_accounts", params=params)
            accounts.extend(a for a in result.get("items", []) if
                            (slugs is None or (a.get("toolkit") or {}).get("slug") in slugs)
                            and a.get("user_id", owner) == owner)
            cursor = result.get("next_cursor")
            if not cursor:
                return accounts
            params = {**params, "cursor": cursor}
        raise ConnectorServiceError("Hay demasiadas conexiones en este proyecto. Revisa las cuentas en Composio.")

    async def authorize(self, slug):
        self.validate_slug(slug)
        # YouTube gets explicit read/upload scopes so the channel can be reviewed.
        config_name = "Open Dots · " + slug + (" · uploads" if slug == "youtube" else "")
        configs = await self.request("GET", "/auth_configs", params={"toolkit_slug": slug, "limit": 100})
        enabled = [c for c in configs.get("items", []) if not c.get("is_disabled")]
        config = next((c for c in enabled if c.get("name") == config_name), None)
        custom = [c for c in enabled if c.get("is_composio_managed") is False]
        if slug == "youtube" and custom:
            # A project can use its own audited Google OAuth app/quota.
            if len(custom) == 1:
                config = custom[0]
            elif not config or config.get("is_composio_managed") is not False:
                raise ConnectorServiceError("Hay varias configuraciones OAuth de YouTube. Nombra la que quieras usar «Open Dots · youtube · uploads» en Composio.")
        if config is None:
            auth = {"type": "use_composio_managed_auth", "name": config_name}
            if slug == "youtube":
                auth["credentials"] = {"scopes": ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"]}
            created = await self.request("POST", "/auth_configs", json={"toolkit": {"slug": slug}, "auth_config": auth})
            config = created.get("auth_config") or {}
        config_id = config.get("id")
        if not config_id:
            raise ConnectorServiceError("Composio no ha creado la conexión. Revisa el conector en su panel.")
        result = await self.request("POST", "/connected_accounts/link", json={"auth_config_id": config_id, "user_id": self.user_id()})
        url = result.get("redirect_url", "")
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.username or parsed.password or not (parsed.hostname or "").endswith(".composio.dev"):
            raise ConnectorServiceError("El proveedor no devolvió un enlace de autorización válido.")
        return {"url": url}

    async def disconnect(self, slug):
        accounts = await self.accounts([slug])
        for account in accounts:
            account_id = account.get("id", "")
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", account_id):
                raise ConnectorServiceError("El proveedor devolvió una cuenta no válida.")
            await self.request("DELETE", "/connected_accounts/" + account_id)
        return len(accounts)

    async def proxy(self, account_id, endpoint, method="GET", **kwargs):
        return await self.request("POST", "/tools/execute/proxy", json={
            "connected_account_id": account_id, "endpoint": endpoint, "method": method, **kwargs,
        })

    async def execute(self, slug, name, arguments):
        accounts = [a for a in await self.accounts([slug]) if a.get("status") == "ACTIVE"]
        if len(accounts) != 1:
            raise ConnectorServiceError("Conecta una única cuenta de " + slug + " en Conectores.")
        result = await self.request("POST", "/tools/execute/" + name, json={
            "connected_account_id": accounts[0]["id"], "user_id": self.user_id(),
            "version": "latest", "arguments": arguments,
        })
        if result.get("successful") is False:
            raise ConnectorServiceError("La aplicación ha rechazado la acción. Revisa la conexión y los permisos.")
        return result


connector_service = ConnectorService()
