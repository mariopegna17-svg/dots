from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from app.services.communication_service import CommunicationError
from app.services.whatsapp_qr_service import WhatsAppQRSettings, whatsapp_qr_service

router = APIRouter(prefix="/api/v1/communications/whatsapp-qr", tags=["whatsapp"])


@router.get("/status")
async def status():
    return JSONResponse(await whatsapp_qr_service.status(), headers={"Cache-Control": "no-store"})


@router.post("/settings")
async def settings(data: WhatsAppQRSettings):
    try:
        return JSONResponse(await whatsapp_qr_service.save(data), headers={"Cache-Control": "no-store"})
    except CommunicationError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/connect")
async def connect(data: WhatsAppQRSettings):
    try:
        return JSONResponse(await whatsapp_qr_service.connect(data), headers={"Cache-Control": "no-store"})
    except CommunicationError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/disconnect")
async def disconnect():
    try:
        return JSONResponse(await whatsapp_qr_service.disconnect(), headers={"Cache-Control": "no-store"})
    except CommunicationError as exc:
        raise HTTPException(409, str(exc)) from None
