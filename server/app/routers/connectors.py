"""Simple owner-only connector setup and reviewed YouTube publishing."""
import json
import time
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field, ValidationError, field_validator

from app.schemas.youtube import YouTubeConfirmation, YouTubeMetadata
from app.services.composio_service import ConnectorServiceError
from app.services.connector_service import connector_service
from app.services.storage_service import storage_service
from app.services.youtube_service import youtube_service
from app.services.connected_tools import connected_tools

router = APIRouter(prefix="/api/v1/connectors", tags=["connectors"])
CURATED = [
    {"slug": "youtube", "label": "YouTube", "blurb": "Sube vídeos a tu canal con título, descripción y privacidad.", "domain": "youtube.com"},
    {"slug": "github", "label": "GitHub", "blurb": "Consulta incidencias y pide a tu Dot que cree una con tu aprobación.", "domain": "github.com"},
    {"slug": "gmail", "label": "Gmail", "blurb": "Consulta y resume correos; revisa las respuestas antes de enviarlas.", "domain": "gmail.com"},
    {"slug": "googlecalendar", "label": "Google Calendar", "blurb": "Consulta eventos y pide a tu Dot que prepare cambios.", "domain": "calendar.google.com"},
    {"slug": "googledrive", "label": "Google Drive", "blurb": "Busca archivos y trabaja con sus acciones disponibles.", "domain": "drive.google.com"},
    {"slug": "notion", "label": "Notion", "blurb": "Vincula tu espacio de páginas y proyectos.", "domain": "notion.so"},
    {"slug": "slack", "label": "Slack", "blurb": "Vincula tu espacio de trabajo.", "domain": "slack.com"},
    {"slug": "googlesheets", "label": "Google Sheets", "blurb": "Vincula tus hojas de cálculo.", "domain": "sheets.google.com"},
    {"slug": "googledocs", "label": "Google Docs", "blurb": "Vincula tus documentos.", "domain": "docs.google.com"},
    {"slug": "discord", "label": "Discord", "blurb": "Vincula tu cuenta de Discord.", "domain": "discord.com"},
    {"slug": "linear", "label": "Linear", "blurb": "Vincula tus proyectos e incidencias.", "domain": "linear.app"},
    {"slug": "trello", "label": "Trello", "blurb": "Vincula tus tableros.", "domain": "trello.com"},
]
_catalog_cache = None
_catalog_at = 0


def fail(exc, code=400):
    raise HTTPException(code, str(exc)) from exc


class ConnectorSetup(BaseModel):
    api_key: str = Field(min_length=10, max_length=500)

    @field_validator("api_key")
    @classmethod
    def valid_key(cls, value):
        value = value.strip()
        if value.startswith("nvapi-"):
            raise ValueError("Aquí necesitas una clave de Composio. La clave de NVIDIA se guarda en Ajustes.")
        if any(c.isspace() for c in value):
            raise ValueError("La clave no puede contener espacios.")
        return value


@router.post("/setup")
async def setup(data: ConnectorSetup):
    try:
        await connector_service.request("GET", "/toolkits", key=data.api_key, params={"limit": 1})
        storage_service.save_settings({"composio_api_key": data.api_key})
        return {"configured": True}
    except ConnectorServiceError as exc:
        fail(exc)


@router.get("/catalog")
async def catalog():
    global _catalog_cache, _catalog_at
    configured = bool(connector_service.key())
    if not configured:
        return {"cards": CURATED, "source": "curated", "configured": False}
    if _catalog_cache and time.time() - _catalog_at < 600:
        return {"cards": _catalog_cache, "source": "api", "configured": True}
    try:
        result = await connector_service.request("GET", "/toolkits", params={"limit": 200, "sort_by": "usage"})
        known = {c["slug"]: c for c in CURATED}
        extra = []
        for item in result.get("items") or result.get("data") or []:
            slug = str(item.get("slug") or "").lower()
            if slug and slug not in known:
                try:
                    connector_service.validate_slug(slug)
                except ConnectorServiceError:
                    continue
                extra.append({"slug": slug, "label": item.get("name") or slug, "blurb": "Vincula tu cuenta con autorización segura."})
        _catalog_cache = CURATED + extra
        _catalog_at = time.time()
        return {"cards": _catalog_cache, "source": "api", "configured": True}
    except ConnectorServiceError as exc:
        return {"cards": CURATED, "source": "curated", "configured": True, "warning": str(exc)}


@router.get("")
async def connection_status(services: str = ""):
    slugs = list(dict.fromkeys(s.strip() for s in services.split(",") if s.strip()))
    if len(slugs) > 60:
        raise HTTPException(400, "Consulta como máximo 60 conectores a la vez.")
    try:
        for slug in slugs:
            connector_service.validate_slug(slug)
        status = {s: {"connected": False} for s in slugs}
        if slugs and connector_service.key():
            for account in await connector_service.accounts(slugs):
                slug = account["toolkit"]["slug"]
                if account.get("status") == "ACTIVE":
                    status[slug] = {"connected": True}
        return {"services": status}
    except ConnectorServiceError as exc:
        fail(exc, 502)


@router.get("/apps")
async def connected_apps():
    try:
        return await connected_tools.apps()
    except ConnectorServiceError as exc:
        fail(exc, 502)


@router.get("/{slug}/actions")
async def available_actions(slug: str, query: str = "", cursor: str = ""):
    try:
        return await connected_tools.search(slug, query, cursor)
    except ConnectorServiceError as exc:
        fail(exc, 502)


@router.get("/youtube/channel")
async def youtube_channel():
    try:
        channel = await youtube_service.channel()
        return {k: v for k, v in channel.items() if k != "account_id"}
    except ConnectorServiceError as exc:
        fail(exc)


@router.get("/youtube/uploads")
async def youtube_uploads():
    youtube_service.cleanup()
    return {"uploads": [youtube_service.public(i) for i in youtube_service.list()]}


@router.post("/youtube/uploads")
async def prepare_youtube(file: Annotated[UploadFile, File()], metadata: Annotated[str, Form()]):
    try:
        parsed = YouTubeMetadata.model_validate_json(metadata)
        return await youtube_service.prepare(file, parsed)
    except ValidationError:
        raise HTTPException(422, "Revisa el título, la descripción, la privacidad y el público infantil.")
    except ConnectorServiceError as exc:
        fail(exc)
    finally:
        await file.close()


@router.post("/youtube/uploads/{upload_id}/publish")
async def publish_youtube(upload_id: str, data: YouTubeConfirmation):
    try:
        return await youtube_service.publish(upload_id)
    except ConnectorServiceError as exc:
        fail(exc, 409)


@router.delete("/youtube/uploads/{upload_id}")
async def discard_youtube(upload_id: str):
    try:
        youtube_service.discard(upload_id)
        return {"removed": True}
    except ConnectorServiceError as exc:
        fail(exc)


@router.post("/{slug}/authorize")
async def authorize(slug: str):
    try:
        result = await connector_service.authorize(slug)
        storage_service.add_audit_event({"event": "connector.authorization_requested", "connector": slug})
        return result
    except ConnectorServiceError as exc:
        fail(exc, 502)


@router.delete("/{slug}")
async def disconnect(slug: str):
    try:
        removed = await connector_service.disconnect(slug)
        storage_service.add_audit_event({"event": "connector.disconnected", "connector": slug, "removed": removed})
        return {"removed": removed, "slug": slug}
    except ConnectorServiceError as exc:
        fail(exc, 502)
