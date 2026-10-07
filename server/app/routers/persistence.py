import asyncio
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from app.services.github_backup import BackupError, backup_service

router = APIRouter(prefix="/api/v1/persistence", tags=["persistence"])


@router.get("/status")
async def status():
    return backup_service.status()


@router.post("/sync")
async def sync():
    try:
        await asyncio.to_thread(backup_service.sync)
        return backup_service.status()
    except BackupError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/download")
async def download():
    try:
        def capture():
            with backup_service.lock:
                payload, _ = backup_service.capture()
                return backup_service.encrypt(payload)
        encrypted = await asyncio.to_thread(capture)
        return Response(encrypted, media_type="application/octet-stream", headers={"Content-Disposition": 'attachment; filename="dots-state.enc"', "Cache-Control": "no-store"})
    except BackupError as exc:
        raise HTTPException(409, str(exc)) from exc
