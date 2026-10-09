import json
import uuid
import asyncio
from contextlib import aclosing
from collections import OrderedDict
from datetime import datetime
from zoneinfo import ZoneInfo
from app.config import settings
from fastapi import APIRouter, Query
from sse_starlette.sse import EventSourceResponse
from typing import List, Optional, Literal

from app.schemas.contracts import TurnRequest, Message
from app.services.storage_service import storage_service
from app.services.provider_service import provider_service
from app.services.agent_service import run_agent
from app.services.action_gateway import (
    ActionGatewayError,
    ActionPolicyError,
    action_gateway,
)
from app.services.connector_actions import ConnectorCommandError, parse_connector_command
from app.services.search_actions import SearchCommandError, parse_search_command
from app.services.workspace_service import (
    WorkspaceToolError,
    parse_workspace_command,
)

router = APIRouter(prefix="/api/v1/chat", tags=["chat"])
_active_turns = {}
_finished_turns = OrderedDict()

@router.get("/history/{thread_id}", response_model=List[Message])
async def get_history(thread_id: str):
    return storage_service.get_messages(thread_id=thread_id)

@router.post("/send")
async def send_message(req: TurnRequest):
    # Store user message
    user_msg = {
        "id": f"msg-{uuid.uuid4().hex}",
        "thread_id": req.thread_id,
        "bot_id": req.bot_id,
        "sender": "user",
        "text": req.user_text,
        "image_url": req.image_url,
        "created_at": datetime.now().isoformat(),
        "model": req.model or next(
            (bot.get("model") for bot in storage_service.get_bots() if bot.get("id") == req.bot_id),
            storage_service.get_settings().get("default_model", "gpt-5-mini"),
        ),
        "item_type": "user_text"
    }

    storage_service.add_message(user_msg)
    return {"status": "ok", "message": user_msg}

@router.get("/stream/{thread_id}")
async def stream_turn(thread_id: str, model: Optional[str] = Query(None), response_mode: Literal["text", "voice"] = Query("text")):
    """
    SSE stream endpoint broadcasting real-time tokens & tool events for a given thread.
    """
    history = storage_service.get_messages(thread_id=thread_id)
    bots = storage_service.get_bots()
    current_bot = next((b for b in bots if b["id"] == thread_id), None)

    raw_prompt = current_bot["system_prompt"] if current_bot else "You are a helpful AI assistant."
    current_time_str = datetime.now(ZoneInfo(settings.APP_TIMEZONE)).isoformat() + f" ({settings.APP_TIMEZONE})"
    system_prompt = f"Current Date & Time: {current_time_str}.\n\n{raw_prompt}"
    selected_model = model or (current_bot["model"] if current_bot else "gpt-5-mini")

    formatted_history = []
    for m in history:
        if m["sender"] in ["user", "bot"]:
            formatted_history.append({
                "role": "user" if m["sender"] == "user" else "assistant",
                "content": m.get("text", ""),
                "image_url": m.get("image_url")
            })


    async def generate_events():
        bot_msg_id = f"msg-{uuid.uuid4().hex}"
        accumulated_text = ""
        tool_context = ""

        # Emit turn started
        yield {
            "event": "message",
            "data": json.dumps({"type": "turn.started", "botMsgId": bot_msg_id, "model": selected_model})
        }

        last_user_text = formatted_history[-1]["content"] if formatted_history else ""
        try:
            action_call = parse_workspace_command(last_user_text)
            if action_call is None:
                action_call = parse_connector_command(last_user_text)
            if action_call is None:
                action_call = parse_search_command(last_user_text)
        except (WorkspaceToolError, ConnectorCommandError, SearchCommandError) as exc:
            action_call = None
            lowered_text = last_user_text.lower()
            if lowered_text.startswith("/connector"):
                command_tool = "connector"
            elif lowered_text.startswith("/search"):
                command_tool = "search"
            else:
                command_tool = "workspace"
            tool_context = f"A {command_tool} request was rejected before execution: {exc}"
            yield {
                "event": "message",
                "data": json.dumps({
                    "type": "tool.failed",
                    "tool": command_tool,
                    "error": str(exc),
                }),
            }

        if action_call:
            try:
                action_request, approval = action_gateway.open(
                    thread_id,
                    thread_id,
                    action_call,
                )
            except ActionPolicyError as exc:
                tool_context = f"Action rejected by policy: {exc}"
                yield {
                    "event": "message",
                    "data": json.dumps({
                        "type": "tool.failed",
                        "tool": action_call.name,
                        "requestId": exc.request_id,
                        "error": str(exc),
                    }),
                }
            else:
                if approval:
                    yield {
                        "event": "message",
                        "data": json.dumps({
                            "type": "request.opened",
                            "requestType": "permission",
                            "requestId": action_request.request_id,
                            "tool": approval["tool"],
                            "summary": approval["summary"],
                            "arguments": approval["arguments"],
                            "action": action_request.model_dump(),
                        }),
                    }

                decision = await action_gateway.wait_for_decision(action_request)
                action_name = f"{action_request.tool}.{action_request.action}"
                if decision == "allow":
                    yield {
                        "event": "message",
                        "data": json.dumps({
                            "type": "tool.started",
                            "tool": action_name,
                            "requestId": action_request.request_id,
                            "action": action_request.model_dump(),
                        }),
                    }
                    try:
                        action_result = await action_gateway.execute(action_request)
                    except ActionGatewayError as exc:
                        tool_context = f"Action could not execute ({action_name}): {exc}"
                        yield {
                            "event": "message",
                            "data": json.dumps({
                                "type": "tool.failed",
                                "tool": action_name,
                                "requestId": action_request.request_id,
                                "error": str(exc),
                            }),
                        }
                    else:
                        if action_result.status == "completed":
                            result = action_result.result or {}
                            tool_context = f"Action result ({action_name}): {json.dumps(result)}"
                            yield {
                                "event": "message",
                                "data": json.dumps({
                                    "type": "tool.completed",
                                    "tool": action_name,
                                    "requestId": action_request.request_id,
                                    "result": result,
                                }),
                            }
                        else:
                            error = action_result.error or "The action failed."
                            tool_context = f"Action failed ({action_name}): {error}"
                            yield {
                                "event": "message",
                                "data": json.dumps({
                                    "type": "tool.failed",
                                    "tool": action_name,
                                    "requestId": action_request.request_id,
                                    "error": error,
                                }),
                            }
                elif decision == "deny":
                    tool_context = f"Action denied by the user: {action_name}"
                    yield {
                        "event": "message",
                        "data": json.dumps({
                            "type": "tool.denied",
                            "tool": action_name,
                            "requestId": action_request.request_id,
                        }),
                    }
                else:
                    tool_context = f"Action expired before approval: {action_name}"
                    yield {
                        "event": "message",
                        "data": json.dumps({
                            "type": "tool.expired",
                            "tool": action_name,
                            "requestId": action_request.request_id,
                        }),
                    }

        provider_prompt = f"{system_prompt}\n\n{tool_context}" if tool_context else system_prompt

        # Stream content from inference adapter
        agent_stream = run_agent(
            bot_id=thread_id,
            model=selected_model,
            messages=formatted_history,
            system_prompt=provider_prompt,
            response_mode=response_mode,
        )
        try:
            async for event in agent_stream:
                if event["type"] == "content.delta":
                    accumulated_text += event["delta"]
                    yield {
                        "event": "message",
                        "data": json.dumps({
                            "type": "content.delta",
                            "botMsgId": bot_msg_id,
                            "delta": event["delta"]
                        })
                    }
                elif event["type"] == "turn.completed":
                    ok = event.get("ok", True)
                    if ok:
                        bot_msg = {
                            "id": bot_msg_id,
                            "thread_id": thread_id,
                            "bot_id": thread_id,
                            "sender": "bot",
                            "text": accumulated_text,
                            "created_at": datetime.now().isoformat(),
                            "model": selected_model,
                            "item_type": "assistant_text"
                        }
                        storage_service.add_message(bot_msg)
                    yield {
                        "event": "message",
                        "data": json.dumps({"type": "turn.completed", "ok": ok, "botMsgId": bot_msg_id})
                    }
                else:
                    yield {"event": "message", "data": json.dumps(event)}
        finally:
            await agent_stream.aclose()

    async def event_generator():
        latest_user = next((item for item in reversed(history) if item.get("sender") == "user"), None)
        message_id = latest_user.get("id") if latest_user else None
        turn_key = (thread_id, message_id) if message_id else None
        rejected = thread_id in _active_turns or (turn_key and turn_key in _finished_turns) or (latest_user and history[-1].get("sender") == "bot")
        if not rejected and turn_key:
            rejected = not storage_service.claim_chat_turn(thread_id, message_id)
        if rejected:
            rejected_message_id = f"msg-{uuid.uuid4().hex}"
            yield {"event": "message", "data": json.dumps({"type": "turn.started", "botMsgId": rejected_message_id, "model": selected_model})}
            yield {"event": "message", "data": json.dumps({"type": "content.delta", "botMsgId": rejected_message_id, "delta": "Esta petición ya está en curso o ha terminado. Revisa el chat; para intentarlo de nuevo, escribe otra petición. No se ha repetido ningún envío."})}
            yield {"event": "message", "data": json.dumps({"type": "turn.completed", "ok": False, "botMsgId": rejected_message_id})}
            return
        _active_turns[thread_id] = message_id
        terminal_status = "cancelled"
        opened_requests = []
        try:
            async with aclosing(generate_events()) as stream:
                async for event in stream:
                    data = json.loads(event["data"])
                    if data.get("type") == "turn.completed":
                        terminal_status = "failed" if data.get("ok") is False else "completed"
                    if data.get("type") == "request.opened":
                        opened_requests.append(data["requestId"])
                    yield event
        except Exception:
            terminal_status = "failed"
            raise
        finally:
            for request_id in opened_requests:
                pending = action_gateway.get_pending_request(request_id)
                if pending:
                    action_gateway.cancel_pending(pending)
            _active_turns.pop(thread_id, None)
            if turn_key:
                storage_service.finish_chat_turn(thread_id, message_id, terminal_status)
                _finished_turns[turn_key] = True
                while len(_finished_turns) > 512:
                    _finished_turns.popitem(last=False)

    return EventSourceResponse(event_generator())
