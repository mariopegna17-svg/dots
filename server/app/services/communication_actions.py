from app.schemas.communications import CommunicationMessage
from app.services.action_gateway import ActionDefinition, ActionInvocation, action_gateway
from app.services.communication_service import communication_service, CommunicationError


def communication_invocation(name, bot_id, message):
    data = CommunicationMessage(bot_id=bot_id, message=message)
    channel = "voice" if name == "call_owner" else "whatsapp"
    if not communication_service.status()["voice_ready" if channel == "voice" else "whatsapp_ready"]:
        raise CommunicationError("Configura Llamadas y WhatsApp antes de pedir esta acción.")
    number = communication_service.config()["owner_phone_number"]
    label = "Llamarte por teléfono" if channel == "voice" else "Enviarte un WhatsApp"
    return ActionInvocation(name=f"communication.{channel}", arguments=data.model_dump(), target={"owner_phone_number": number}, preview=f"{label} a {number}: {data.message}")


async def execute(invocation):
    return await communication_service.send(invocation.name.split(".")[1], CommunicationMessage.model_validate(invocation.arguments))


for channel, intent in [("voice", "Llamar al número verificado del propietario mediante Twilio."), ("whatsapp", "Enviar un WhatsApp al propietario mediante Twilio.")]:
    action_gateway.register_action(ActionDefinition(name=f"communication.{channel}", tool="communication", action=channel, intent=intent, risk="external", requires_approval=True), execute)
