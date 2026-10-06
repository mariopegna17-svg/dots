import re
from datetime import datetime, timezone

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import Response
from starlette.datastructures import FormData
from urllib.parse import parse_qsl

from app.schemas.communications import CommunicationSettings, CommunicationMessage
from app.services.communication_service import communication_service, CommunicationError, verify_signature, twiml


router = APIRouter(prefix="/api/v1/communications", tags=["communications"])


@router.get("/settings")
async def settings():
    return communication_service.public_config()


@router.post("/settings")
async def save_settings(data: CommunicationSettings):
    try:
        return communication_service.save_config(data)
    except CommunicationError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/events")
async def events():
    return communication_service.recent()


@router.post("/check")
async def check_connection():
    return await communication_service.check_connection()


@router.post("/call")
async def call(data: CommunicationMessage):
    try:
        return await communication_service.send("voice", data)
    except CommunicationError as exc:
        raise HTTPException(409, str(exc)) from None


@router.post("/whatsapp")
async def whatsapp(data: CommunicationMessage):
    try:
        return await communication_service.send("whatsapp", data)
    except CommunicationError as exc:
        raise HTTPException(409, str(exc)) from None


async def signed_form(request, channel, *, outbound=False, require_enabled=True):
    config = communication_service.config()
    if require_enabled and not communication_service.status()["voice_ready" if channel == "voice" else "whatsapp_ready"]:
        raise HTTPException(403, "La conexión no está activa.")
    if request.headers.get("content-type", "").split(";")[0] != "application/x-www-form-urlencoded":
        raise HTTPException(415, "Se requiere un formulario de Twilio.")
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 16384:
            raise HTTPException(413, "Formulario demasiado grande.")
        body.extend(chunk)
    try:
        form = FormData(parse_qsl(body.decode("utf-8"), keep_blank_values=True, max_num_fields=100))
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "Formulario inválido.") from None
    # Never trust Host or forwarded headers when constructing the signed URL.
    url = config["communication_public_url"] + request.url.path
    if request.url.query:
        url += "?" + request.url.query
    if not verify_signature(url, form, config["twilio_auth_token"], request.headers.get("X-Twilio-Signature", "")):
        raise HTTPException(403, "Firma inválida.")
    if form.get("AccountSid") != config["twilio_account_sid"]:
        raise HTTPException(403, "Cuenta no autorizada.")
    expected_from = config["twilio_voice_number"] if channel == "voice" else "whatsapp:" + config["twilio_whatsapp_number" if outbound else "owner_phone_number"]
    expected_to = config["owner_phone_number"] if channel == "voice" else "whatsapp:" + config["owner_phone_number" if outbound else "twilio_whatsapp_number"]
    if form.get("From") != expected_from or form.get("To") != expected_to:
        raise HTTPException(403, "Este canal solo permite al propietario.")
    return config, form


@router.post("/webhooks/status")
async def delivery_status(request: Request, event: str = "", channel: str = ""):
    if channel not in {"voice", "whatsapp"}:
        raise HTTPException(400, "Canal inválido.")
    _, form = await signed_form(request, channel, outbound=True, require_enabled=False)
    record = communication_service.record(event)
    allowed_channels = {"voice_out"} if channel == "voice" else {"whatsapp_out", "whatsapp_in"}
    sid = form.get("CallSid" if channel == "voice" else "MessageSid", "")
    pattern = r"CA[0-9a-fA-F]{32}" if channel == "voice" else r"(?:SM|MM)[0-9a-fA-F]{32}"
    if not record or record["channel"] not in allowed_channels or not re.fullmatch(pattern, sid):
        raise HTTPException(403, "Comunicación no autorizada.")
    provider_sid = record["payload"].get("provider_sid")
    if provider_sid and provider_sid != sid:
        raise HTTPException(403, "Comunicación no autorizada.")
    if not provider_sid and record["status"] != "pending":
        raise HTTPException(403, "Comunicación no autorizada.")
    try:
        code = int(form["ErrorCode"]) if form.get("ErrorCode") else None
        communication_service.delivery(event, sid, form.get("CallStatus" if channel == "voice" else "MessageStatus", ""), code)
    except (CommunicationError, ValueError):
        raise HTTPException(400, "Estado de comunicación inválido.") from None
    return Response(status_code=204)


@router.post("/webhooks/whatsapp")
async def incoming_whatsapp(request: Request, tasks: BackgroundTasks):
    config, form = await signed_form(request, "whatsapp")
    sid = form.get("MessageSid", "")
    text = form.get("Body", "").strip()[:2000]
    bot_id = config["communication_bot_id"]
    if not re.fullmatch(r"(?:SM|MM)[0-9a-fA-F]{32}", sid):
        raise HTTPException(400, "Mensaje inválido.")
    if not text or not communication_service.bot(bot_id):
        return Response('<Response><Message>Selecciona un Dot en la web y envíame un mensaje de texto.</Message></Response>', media_type="application/xml")
    try:
        if communication_service.claim(sid, "whatsapp_in", {"bot_id": bot_id, "message": text}):
            tasks.add_task(communication_service.reply_whatsapp, sid, bot_id, text)
    except CommunicationError:
        return Response('<Response><Message>Se ha alcanzado el límite diario. Continuamos en la web.</Message></Response>', media_type="application/xml")
    return Response("<Response/>", media_type="application/xml")


@router.post("/webhooks/voice")
async def voice_webhook(request: Request, tasks: BackgroundTasks, session: str = "", stage: str = "start", turn: int = 0, poll: int = 0):
    _, form = await signed_form(request, "voice")
    record = communication_service.record(session)
    if not record or record["channel"] != "voice_out" or record["status"] not in {"pending", "submitted", "queued", "initiated", "ringing", "in-progress"}:
        raise HTTPException(403, "Llamada no autorizada.")
    sid = form.get("CallSid", "")
    if record["status"] == "pending" and not record["payload"].get("provider_sid") and re.fullmatch(r"CA[0-9a-fA-F]{32}", sid):
        communication_service.delivery(session, sid, "in-progress")
    elif sid != record["payload"].get("provider_sid"):
        raise HTTPException(403, "Llamada no autorizada.")
    expired = (datetime.now(timezone.utc) - datetime.fromisoformat(record["created_at"])).total_seconds() > 210
    if expired or turn < 0 or turn > 5 or poll < 0 or poll > 20:
        return Response(twiml("Hasta pronto. Podemos continuar en la web.", hangup=True), media_type="application/xml")
    def xml(text):
        return Response(text, media_type="application/xml")
    if stage == "start":
        bot = communication_service.bot(record["payload"]["bot_id"])
        name = bot["name"] if bot else "tu Dot"
        return xml(twiml(f"Hola, soy {name}, tu asistente de inteligencia artificial. {record['payload']['message'][:800]} ¿En qué puedo ayudarte?", gather_url=communication_service.url(session, "listen", 1)))
    event_id = f"{session}:{turn}"
    if stage == "listen":
        text = form.get("SpeechResult", "").strip()[:2000]
        if not text:
            return xml(twiml("No he podido escucharte. Hasta pronto.", hangup=True))
        try:
            if communication_service.claim(event_id, "voice_turn", {"message": text}):
                tasks.add_task(communication_service.reply_voice, event_id, session, record["payload"]["bot_id"], text)
        except CommunicationError:
            return xml(twiml("Continuamos en la web. Hasta pronto.", hangup=True))
        return xml(twiml(redirect_url=communication_service.url(session, "poll", turn)))
    if stage == "poll":
        result = communication_service.record(event_id)
        if result and result["status"] in {"completed", "failed"}:
            return xml(twiml(result["payload"]["reply"], gather_url=communication_service.url(session, "listen", turn + 1)) if turn < 5 else twiml(result["payload"]["reply"], hangup=True))
        return xml(twiml(redirect_url=communication_service.url(session, "poll", turn) + f"&poll={poll + 1}"))
    raise HTTPException(400, "Paso de llamada inválido.")
