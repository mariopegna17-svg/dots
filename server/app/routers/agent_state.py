from datetime import datetime
from typing import Literal
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from app.schemas.contracts import RoutineInput
from app.services.storage_service import storage_service
from app.services.memory_service import memory_service
from app.services.routine_service import routine_service

router = APIRouter(prefix="/api/v1", tags=["memory", "routines"])


def require_bot(bot_id):
    if not any(bot["id"] == bot_id for bot in storage_service.get_bots()):
        raise HTTPException(404, "Agente no encontrado.")


class MemoryInput(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@router.get("/memory/{bot_id}")
async def list_memories(bot_id: str):
    require_bot(bot_id)
    return memory_service.list(bot_id)


@router.post("/memory/{bot_id}")
async def save_memory(bot_id: str, data: MemoryInput):
    require_bot(bot_id)
    try:
        return memory_service.save(bot_id, data.text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.delete("/memory/{bot_id}/{memory_id}")
async def delete_memory(bot_id: str, memory_id: str):
    require_bot(bot_id)
    if not memory_service.delete(bot_id, memory_id):
        raise HTTPException(404, "Memoria no encontrada.")
    return {"status": "ok"}


@router.get("/routines")
async def list_routines(bot_id: str | None = None):
    return routine_service.list(bot_id)


@router.post("/routines")
async def create_routine(data: RoutineInput):
    require_bot(data.bot_id)
    try:
        return routine_service.create(**data.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/routines/{task_id}/{action}")
async def change_routine(task_id: str, action: Literal["pause", "resume", "run"]):
    return _change(task_id, action)


@router.delete("/routines/{task_id}")
async def delete_routine(task_id: str):
    return _change(task_id, "delete")


def _change(task_id, action):
    try:
        result = routine_service.change(task_id, action)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if result is None:
        raise HTTPException(404, "Rutina no encontrada.")
    return result
