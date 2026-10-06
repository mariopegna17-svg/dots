"""Bounded public chat; never exposes the owner's workspace or tools."""
import asyncio
import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, model_validator
from sse_starlette.sse import EventSourceResponse

from app.config import settings
from app.services.provider_service import provider_service
from app.services.storage_service import storage_service

router = APIRouter(prefix="/api/v1/public", tags=["public demo"])
active_requests = 0


class PublicMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=2000)


class PublicChat(BaseModel):
    messages: list[PublicMessage] = Field(min_length=1, max_length=10)

    @model_validator(mode="after")
    def validate_history(self):
        if self.messages[-1].role != "user" or sum(len(m.content) for m in self.messages) > 8000:
            raise ValueError("Termina con un mensaje de usuario y limita el historial a 8000 caracteres.")
        return self


def claim_quota():
    """Share an atomic daily budget across all anonymous visitors."""
    day = datetime.now(timezone.utc).date().isoformat()
    with storage_service.database.connect() as connection:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("CREATE TABLE IF NOT EXISTS public_demo_budget (day TEXT PRIMARY KEY, requests INTEGER NOT NULL)")
        connection.execute("DELETE FROM public_demo_budget WHERE day < ?", (day,))
        connection.execute("INSERT OR IGNORE INTO public_demo_budget VALUES (?, 0)", (day,))
        count = connection.execute("SELECT requests FROM public_demo_budget WHERE day = ?", (day,)).fetchone()[0]
        if count >= settings.PUBLIC_DEMO_DAILY_LIMIT:
            raise HTTPException(429, "Se ha alcanzado el límite diario de la demo. Vuelve mañana.")
        connection.execute("UPDATE public_demo_budget SET requests = requests + 1 WHERE day = ?", (day,))


@router.get("/status")
async def public_status():
    return {"enabled": settings.PUBLIC_DEMO_ENABLED, "daily_limit": settings.PUBLIC_DEMO_DAILY_LIMIT}


@router.post("/chat")
async def public_chat(data: PublicChat):
    global active_requests
    if not settings.PUBLIC_DEMO_ENABLED:
        raise HTTPException(404, "La demo pública no está habilitada.")
    config = storage_service.get_settings()
    if not (config.get("model_api_key") or settings.MODEL_API_KEY):
        raise HTTPException(503, "El propietario todavía debe configurar el proveedor de IA.")
    if active_requests >= 2:
        raise HTTPException(429, "La demo está ocupada. Inténtalo en un momento.")
    claim_quota()
    active_requests += 1

    async def generate():
        global active_requests
        try:
            async with asyncio.timeout(180):
                async for event in provider_service.stream_chat_completion(
                    model=config["default_model"],
                    messages=[m.model_dump() for m in data.messages],
                    system_prompt="Eres Dot, un asistente conversacional. Responde en español con claridad. Estás en una demo pública sin herramientas ni acceso a archivos, recuerdos, rutinas o conversaciones del propietario. No afirmes realizar acciones externas.",
                ):
                    if event["type"] in {"content.delta", "turn.completed"}:
                        yield {"data": json.dumps(event, ensure_ascii=False)}
        except TimeoutError:
            yield {"data": json.dumps({"type": "content.delta", "delta": "La respuesta tardó demasiado. Inténtalo de nuevo."})}
            yield {"data": json.dumps({"type": "turn.completed", "ok": False})}
        finally:
            active_requests -= 1

    return EventSourceResponse(generate())
