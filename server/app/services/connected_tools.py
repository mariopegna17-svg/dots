"""Discover real tools for authorized apps and execute through the approval gateway."""
import hashlib
import json
import re

from jsonschema import validators, ValidationError, SchemaError

from app.services.action_gateway import ActionDefinition, ActionInvocation, action_gateway, redact_sensitive
from app.services.composio_service import ConnectorServiceError
from app.services.connector_service import connector_service

SAFE_ACTION = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,199}$")
MUTATING_TAGS = {"createHint", "updateHint", "destructiveHint"}
PAGINATION_KEYS = {"nextPageToken", "next_page_token", "pageToken", "page_token"}


def safe_result(value, key="", depth=0):
    """Bound model context, hide credentials, and preserve usable pagination cursors."""
    if depth > 12:
        return "[Resultado anidado omitido]"
    if key not in PAGINATION_KEYS and redact_sensitive("probe", key) == "[REDACTED]":
        return "[REDACTED]"
    if isinstance(value, dict):
        result = {str(k): safe_result(v, str(k), depth + 1) for k, v in list(value.items())[:80]}
        if len(value) > 80:
            result["_truncated"] = True
        return result
    if isinstance(value, list):
        result = [safe_result(v, depth=depth + 1) for v in value[:40]]
        if len(value) > 40:
            result.append({"_truncated": True, "remaining": len(value) - 40})
        return result
    if isinstance(value, str):
        text = str(redact_sensitive(value))
        return text if len(text) <= 10000 else text[:10000] + "\n[Contenido recortado]"
    return value


def validate_schema(schema, arguments):
    def check_refs(value):
        if isinstance(value, dict):
            if any(ref in value and not str(value[ref]).startswith("#") for ref in ("$ref", "$dynamicRef", "$recursiveRef")):
                raise ConnectorServiceError("El esquema de esta acción usa una referencia externa no compatible.")
            for v in value.values():
                check_refs(v)
        elif isinstance(value, list):
            for v in value:
                check_refs(v)
    check_refs(schema)
    try:
        validator = validators.validator_for(schema)
        validator.check_schema(schema)
        errors = list(validator(schema).iter_errors(arguments))
    except (SchemaError, ValidationError) as exc:
        raise ConnectorServiceError("El proveedor devolvió un esquema de acción no válido.") from exc
    if errors:
        error = errors[0]
        location = ".".join(str(p) for p in error.absolute_path) or "arguments"
        if error.validator == "required":
            missing = [name for name in error.validator_value if name not in error.instance]
            detail = "Faltan parámetros: " + ", ".join(missing)
        else:
            detail = f"Revisa el parámetro {location} ({error.validator})"
        raise ConnectorServiceError(detail + ". Consulta el esquema de la acción antes de ejecutarla.")


class ConnectedTools:
    def __init__(self, connectors=connector_service):
        self.connectors = connectors

    def fingerprint(self):
        return hashlib.sha256(self.connectors.key().encode()).hexdigest()

    async def apps(self):
        if not self.connectors.key():
            return {"configured": False, "apps": [], "message": "Guarda tu clave de Composio en Conectores y autoriza la cuenta."}
        groups = {}
        for account in await self.connectors.accounts():
            toolkit = account.get("toolkit") or {}
            slug = toolkit.get("slug", "")
            try:
                self.connectors.validate_slug(slug)
            except ConnectorServiceError:
                continue
            app = groups.setdefault(slug, {"slug": slug, "name": toolkit.get("name") or slug,
                "active_accounts": 0, "statuses": []})
            app["active_accounts"] += int(account.get("status") == "ACTIVE")
            if account.get("status") not in app["statuses"]:
                app["statuses"].append(account.get("status"))
        return {"configured": True, "apps": list(groups.values())}

    async def account(self, app):
        self.connectors.validate_slug(app)
        accounts = [a for a in await self.connectors.accounts([app]) if a.get("status") == "ACTIVE"]
        if not accounts:
            raise ConnectorServiceError(f"{app} no tiene una cuenta activa. Abre Conectores y conecta o renueva la autorización.")
        if len(accounts) != 1:
            raise ConnectorServiceError(f"Hay varias cuentas activas de {app}. Deja conectada solo la que quieras usar.")
        return accounts[0]

    @staticmethod
    def action_info(raw, app):
        slug = raw.get("slug", "")
        if not SAFE_ACTION.fullmatch(slug) or (raw.get("toolkit") or {}).get("slug") != app:
            raise ConnectorServiceError("La acción no pertenece al conector solicitado.")
        if raw.get("is_deprecated"):
            raise ConnectorServiceError("Esta acción está obsoleta. Busca una acción vigente del conector.")
        schema = raw.get("input_parameters")
        if not isinstance(schema, dict):
            raise ConnectorServiceError("El proveedor no devolvió los parámetros de esta acción.")
        tags = set(raw.get("tags") or [])
        read_only = "readOnlyHint" in tags and not tags.intersection(MUTATING_TAGS)
        return {"action": slug, "name": raw.get("name") or slug, "description": (raw.get("description") or "")[:3000],
            "app": app, "parameters": schema, "version": raw.get("version") or "latest",
            "requires_approval": not read_only, "read_only": read_only}

    async def search(self, app, query="", cursor=""):
        account = await self.account(app)
        if not isinstance(query, str) or len(query) > 250 or not isinstance(cursor, str) or len(cursor) > 2000:
            raise ConnectorServiceError("La búsqueda de acciones no es válida.")
        params = {"toolkit_slug": app, "limit": 6, "include_deprecated": False, "toolkit_versions": "latest"}
        if query.strip():
            params["search"] = query.strip()
        if cursor:
            params["cursor"] = cursor
        auth_config = (account.get("auth_config") or {}).get("id")
        if auth_config:
            params["auth_config_ids"] = auth_config
        result = await self.connectors.request("GET", "/tools", params=params)
        actions = []
        for raw in result.get("items", [])[:6]:
            try:
                actions.append(self.action_info(raw, app))
            except ConnectorServiceError:
                continue
        return {"app": app, "actions": actions, "next_cursor": result.get("next_cursor"),
            "message": "Usa el action y los parámetros exactos de este esquema. No inventes IDs ni destinatarios."}

    async def prepare(self, app, action, arguments):
        if not isinstance(action, str) or not SAFE_ACTION.fullmatch(action):
            raise ConnectorServiceError("El identificador de acción no es válido.")
        if not isinstance(arguments, dict) or len(json.dumps(arguments, ensure_ascii=False)) > 50000:
            raise ConnectorServiceError("Los parámetros deben ser un objeto JSON de hasta 50 KB.")
        account = await self.account(app)
        raw = await self.connectors.request("GET", "/tools/" + action, params={"version": "latest"})
        info = self.action_info(raw, app)
        if info["action"] != action:
            raise ConnectorServiceError("El proveedor devolvió una acción distinta.")
        if app == "youtube" and "UPLOAD" in action.upper():
            raise ConnectorServiceError("Para subir vídeos prepara un borrador en Conectores → YouTube y usa youtube_publish_video.")
        validate_schema(info["parameters"], arguments)
        gateway_name = "connector.read" if info["read_only"] else "connector.change"
        return ActionInvocation(name=gateway_name,
            arguments={"app": app, "action": action, "parameters": arguments, "account_id": account["id"],
                       "version": info["version"], "key_fingerprint": self.fingerprint()},
            display_arguments={"aplicación": app, "acción": info["name"], "parámetros": redact_sensitive(arguments)},
            target={"connector": app, "action": action},
            preview=f"{app} · {info['name']}" + (" · consulta" if info["read_only"] else " · revisa los datos antes de autorizar"))

    async def execute(self, invocation):
        data = invocation.arguments
        account = await self.account(data["app"])
        if data["account_id"] != account["id"] or data["key_fingerprint"] != self.fingerprint():
            raise ConnectorServiceError("La cuenta o la configuración han cambiado. Solicita la acción de nuevo.")
        result = await self.connectors.request("POST", "/tools/execute/" + data["action"], json={
            "connected_account_id": account["id"], "user_id": self.connectors.user_id(),
            "version": data["version"], "arguments": data["parameters"],
        })
        if result.get("successful") is not True:
            raw = str(result.get("error") or "").lower()
            if any(marker in raw for marker in ("scope", "permission", "unauthorized", "forbidden", "invalid_grant", "expired")):
                message = "La cuenta está vinculada, pero falta permiso o ha caducado. Desconecta y vuelve a autorizar este conector."
            elif any(marker in raw for marker in ("argument", "parameter", "validation")):
                message = "El conector rechazó los parámetros. Consulta su esquema y corrige los datos; no repitas una escritura sin revisar el resultado."
            else:
                message = "El conector no completó la acción. Comprueba la cuenta y los permisos; no se confirma que se haya ejecutado."
            raise ConnectorServiceError(message)
        payload = safe_result(result.get("data") or {})
        if len(json.dumps(payload, ensure_ascii=False)) > 60000:
            payload = {"excerpt": json.dumps(payload, ensure_ascii=False)[:60000], "truncated": True}
        return {"connector": data["app"], "action": data["action"], "data": payload}


connected_tools = ConnectedTools()
action_gateway.register_action(ActionDefinition(name="connector.read", tool="connector", action="read",
    intent="Consultar información de una cuenta conectada.", risk="read", requires_approval=False), connected_tools.execute)
action_gateway.register_action(ActionDefinition(name="connector.change", tool="connector", action="change",
    intent="Realizar la acción revisada en una cuenta conectada.", risk="external", requires_approval=True), connected_tools.execute)
