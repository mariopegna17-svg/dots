import uuid
from app.schemas.communications import CommunicationMessage
from app.services.action_gateway import ActionDefinition, ActionInvocation, action_gateway
from app.services.communication_service import communication_service, CommunicationError
from app.services.whatsapp_qr_service import whatsapp_qr_service


async def communication_capabilities(twilio_status=None):
    twilio = twilio_status if twilio_status is not None else communication_service.status()
    qr = await whatsapp_qr_service.owner_status()
    whatsapp = {"ready": twilio["whatsapp_ready"], "provider": "twilio", "issues": twilio["setup_issues"]["whatsapp"]}
    if qr["enabled"]:
        whatsapp = {key: qr[key] for key in ("ready", "state", "error", "mode", "owner_phone_number")}
        whatsapp["provider"] = "qr"
    return {"voice": {"ready": twilio["voice_ready"], "provider": "twilio", "issues": twilio["setup_issues"]["voice"]}, "whatsapp": whatsapp,
            "note": "WhatsApp por QR es independiente de las cuentas de Composio. Para enviar al propietario usa whatsapp_owner; la ventana de 24 horas solo se aplica a Twilio."}


async def prepare_communication_invocation(name, bot_id, message):
    if name != "whatsapp_owner" or not whatsapp_qr_service.config()["enabled"]:
        return communication_invocation(name, bot_id, message)
    data = CommunicationMessage(bot_id=bot_id, message=message)
    state = await whatsapp_qr_service.owner_status()
    if not state["ready"]:
        raise CommunicationError(state["error"] or "WhatsApp por QR no está conectado.")
    expected = {key: state[key] for key in ("connection_id", "mode", "owner_phone_number", "account_phone")}
    return ActionInvocation(name="communication.whatsapp_qr", arguments={**data.model_dump(), "expected": expected, "event_id": uuid.uuid4().hex},
        target={"owner_phone_number": state["owner_phone_number"], "provider": "qr"},
        display_arguments={"canal": "WhatsApp por QR", "destinatario": state["owner_phone_number"], "mensaje": data.message},
        preview=f"Enviarte un WhatsApp por QR a {state['owner_phone_number']}: {data.message}")


def communication_invocation(name, bot_id, message):
    data = CommunicationMessage(bot_id=bot_id, message=message)
    channel = "voice" if name == "call_owner" else "whatsapp"
    if not communication_service.status()["voice_ready" if channel == "voice" else "whatsapp_ready"]:
        raise CommunicationError("Configura Llamadas y WhatsApp antes de pedir esta acción.")
    number = communication_service.config()["owner_phone_number"]
    label = "Llamarte por teléfono" if channel == "voice" else "Enviarte un WhatsApp"
    return ActionInvocation(name=f"communication.{channel}", arguments=data.model_dump(), target={"owner_phone_number": number}, preview=f"{label} a {number}: {data.message}")


async def execute(invocation):
    if invocation.name == "communication.whatsapp_qr":
        data = CommunicationMessage.model_validate({key: invocation.arguments[key] for key in ("bot_id", "message")})
        return await whatsapp_qr_service.send_owner(data, invocation.arguments["expected"], invocation.arguments["event_id"])
    return await communication_service.send(invocation.name.split(".")[1], CommunicationMessage.model_validate(invocation.arguments))


for channel, intent in [("voice", "Llamar al número verificado del propietario mediante Twilio."), ("whatsapp", "Enviar un WhatsApp al propietario mediante Twilio."), ("whatsapp_qr", "Enviar un WhatsApp al propietario con su sesión QR vinculada.")]:
    action_gateway.register_action(ActionDefinition(name=f"communication.{channel}", tool="communication", action=channel, intent=intent, risk="external", requires_approval=True), execute)
