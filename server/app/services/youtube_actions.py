"""Dots can publish only owner-uploaded drafts, after a concrete approval."""
from app.services.action_gateway import ActionDefinition, ActionInvocation, action_gateway
from app.services.youtube_service import youtube_service
from app.services.composio_service import ConnectorServiceError


def youtube_invocation(upload_id):
    item = youtube_service.get(upload_id)
    if item["status"] != "ready":
        raise ConnectorServiceError("Prepara primero un vídeo en Conectores → YouTube.")
    privacy = {"private": "privado", "unlisted": "oculto", "public": "público"}[item["privacy"]]
    return ActionInvocation(name="youtube.publish", arguments={"upload_id": upload_id},
        target={"channel_id": item["channel_id"], "channel": item["channel_name"]},
        preview=f"Subir «{item['title']}» a {item['channel_name']} como vídeo {privacy}",
        display_arguments={"upload_id": upload_id, "filename": item["filename"], "title": item["title"],
                           "description": item["description"], "privacy": privacy, "made_for_kids": item["made_for_kids"], "size_bytes": item["size"]})


async def execute_youtube(call):
    return await youtube_service.publish(call.arguments["upload_id"])


action_gateway.register_action(ActionDefinition(name="youtube.publish", tool="youtube", action="publish",
    intent="Subir a YouTube el vídeo y los datos revisados por el propietario.", risk="external", requires_approval=True), execute_youtube)
