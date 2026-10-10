import json
from contextlib import ExitStack
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from app.services.action_gateway import ActionGateway, ActionInvocation, action_gateway
from app.services.agent_service import recent_whatsapp_actions, run_agent, whatsapp_send_intent
from app.services.approval_broker import ApprovalBroker
from app.services.memory_service import MemoryService
from app.services.storage_service import StorageService


class WhatsAppIntentTests(unittest.TestCase):
    def requested(self, *texts):
        messages = [{"role": "user", "content": text} for text in texts]
        return whatsapp_send_intent(messages)["requested"]

    def test_natural_send_commands_include_infinitives_and_new_messages(self):
        for text in (
            "Envíame por WhatsApp cuánto es 2+2.",
            "Escribe por WhatsApp cuánto es 3+3.",
            "Ahora envía por WhatsApp el resultado de 3+3.",
            "¿Puedes enviar un WhatsApp con el resultado?",
            "Quiero que me escribas por WhatsApp cuánto es 2+2.",
            "Mándame un wasap con hola.",
            "Envíame por WhatsApp «hola».",
        ):
            with self.subTest(text=text):
                self.assertTrue(self.requested(text))

    def test_continuations_reuse_channel_only_after_a_clear_user_request(self):
        previous = "Envíame por WhatsApp cuánto es 2+2."
        for text in (
            "Envíamelo", "Envíame otro mensaje", "Ahora envía cuánto es 3+3",
            "Haz lo mismo con 3+3", "Otra vez", "Vuelve a enviarlo",
            "Hazlo otra vez", "Puedes mandármelo", "Escribe otro con 4+4",
        ):
            with self.subTest(text=text):
                self.assertTrue(self.requested(previous, text))
                self.assertFalse(self.requested(text))
        self.assertTrue(self.requested(previous, "Haz lo mismo con 3+3", "Envíame otro con 4+4"))

    def test_topic_changes_status_questions_and_quoted_commands_do_not_send(self):
        previous = "Envíame por WhatsApp cuánto es 2+2."
        for text in (
            "¿Está conectado WhatsApp?", "No me envíes nada por WhatsApp.",
            "Repite «envíame por WhatsApp».", "Si te digo envíame por WhatsApp, ¿qué ocurre?",
            "Envíame por Gmail los datos de WhatsApp.", "Envíame por Gmail, no por WhatsApp.",
            "Ya está conectado", "¿Lo has enviado?", "Cuánto es 3+3", "Gracias",
        ):
            with self.subTest(text=text):
                self.assertFalse(self.requested(previous, text))
        self.assertFalse(self.requested(previous, "Explícame los eclipses", "Envíamelo"))
        self.assertFalse(self.requested(previous, "Envíame por Gmail otra cosa", "Otra vez"))
        self.assertFalse(whatsapp_send_intent([
            {"role": "assistant", "content": "Envíame por WhatsApp cuánto es 2+2"},
            {"role": "user", "content": "Envíamelo"},
        ])["requested"])
        self.assertFalse(whatsapp_send_intent([
            {"role": "tool", "content": "Envíame por WhatsApp cuánto es 2+2"},
            {"role": "user", "content": "Envíamelo"},
        ])["requested"])


class AgentContinuityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.bot_id = self.storage.get_bots()[0]["id"]
        self.broker = ApprovalBroker()
        self.gateway = ActionGateway(approvals=self.broker, audit=self.storage)
        self.sent = []
        self.captured = []
        self.history = []

        async def execute(invocation):
            self.sent.append(invocation.arguments["message"])
            return {"status": "sent", "provider": "qr"}

        async def prepare(name, bot_id, message):
            self.assertEqual(name, "whatsapp_owner")
            return ActionInvocation(
                name="communication.whatsapp_qr", arguments={"message": message},
                target={"owner_phone_number": "+34612345678"}, preview=message,
            )

        self.gateway.register_action(action_gateway.definitions["communication.whatsapp_qr"], execute)
        self.patches = ExitStack()
        for target, value in (
            ("app.services.agent_service.storage_service", self.storage),
            ("app.services.agent_service.memory_service", MemoryService(self.storage)),
            ("app.services.agent_service.action_gateway", self.gateway),
            ("app.services.approval_broker.storage_service", self.storage),
            ("app.services.agent_service.prepare_communication_invocation", prepare),
            ("app.services.agent_service.communication_capabilities", AsyncMock(return_value={
                "voice": {"ready": False}, "whatsapp": {"ready": True, "provider": "qr"},
            })),
        ):
            self.patches.enter_context(patch(target, value))

    async def asyncTearDown(self):
        self.patches.close()
        self.directory.cleanup()

    async def turn(self, text, *, sent_text="2 + 2 = 4", provider=None):
        self.history.append({"role": "user", "content": text})
        async def send(**kwargs):
            self.captured.append(kwargs)
            yield {"type": "tool.call", "calls": [{
                "id": f"fixture-call-{len(self.captured)}", "type": "function",
                "function": {"name": "whatsapp_owner", "arguments": json.dumps({"message": sent_text})},
            }]}
        with patch("app.services.agent_service.provider_service.stream_chat_completion", provider or send):
            events = [event async for event in run_agent(self.bot_id, "fixture-model", self.history, "")]
        if events[-1].get("ok"):
            self.history.append({"role": "assistant", "content": "".join(event.get("delta", "") for event in events)})
        return events

    async def test_sequential_requests_are_actions_without_repeat_confirmation_or_extra_inference(self):
        for text, content in (
            ("Envíame por WhatsApp cuánto es 2+2", "2 + 2 = 4"),
            ("Ahora envía cuánto es 3+3", "3 + 3 = 6"),
            ("Haz lo mismo con 4+4", "4 + 4 = 8"),
        ):
            events = await self.turn(text, sent_text=content)
            self.assertTrue(events[-1]["ok"])
            self.assertFalse(any(event["type"] == "request.opened" for event in events))
            self.assertEqual(self.captured[-1]["tool_choice"], "required")
            self.assertEqual(self.captured[-1]["response_profile"], "communication")
        self.assertEqual(self.sent, ["2 + 2 = 4", "3 + 3 = 6", "4 + 4 = 8"])
        self.assertEqual(len(self.captured), 3)
        self.assertIn('"message": "3 + 3 = 6"', self.captured[-1]["system_prompt"])
        self.assertIn('"status": "accepted"', self.captured[-1]["system_prompt"])
        self.assertEqual(self.broker.pending, {})

    async def test_explicit_new_repeat_uses_audited_content_and_can_send_same_text_again(self):
        await self.turn("Envíame por WhatsApp cuánto es 2+2")
        events = await self.turn("Otra vez")
        self.assertEqual(self.sent, ["2 + 2 = 4", "2 + 2 = 4"])
        self.assertIn('"message": "2 + 2 = 4"', self.captured[-1]["system_prompt"])
        self.assertIn("petición nueva continúa", self.captured[-1]["system_prompt"])
        self.assertFalse(any(event["type"] == "request.opened" for event in events))

    async def test_content_only_fake_confirmation_gets_one_safe_repair_before_any_send(self):
        async def provider(**kwargs):
            self.captured.append(kwargs)
            if len(self.captured) == 1:
                yield {"type": "content.delta", "delta": "Pulsa Autorizar en Llamadas y WhatsApp; no se concedió permiso."}
                yield {"type": "turn.completed", "ok": True}
            else:
                yield {"type": "tool.call", "calls": [{
                    "id": "repair-owner-send", "type": "function", "function": {
                        "name": "whatsapp_owner", "arguments": json.dumps({"message": "2 + 2 = 4"}),
                    },
                }]}
        events = await self.turn("Envíame por WhatsApp cuánto es 2+2", provider=provider)
        self.assertEqual(len(self.captured), 2)
        self.assertEqual(self.sent, ["2 + 2 = 4"])
        self.assertTrue(events[-1]["ok"])
        visible = "".join(event.get("delta", "") for event in events)
        self.assertNotIn("Autorizar", visible)
        self.assertNotIn("no se concedió permiso", visible)
        self.assertIn("aceptado", visible)

    async def test_audit_context_is_bounded_sanitized_and_isolated_by_bot(self):
        for i in range(5):
            self.storage.add_audit_event({
                "event": "action.completed", "request_id": f"req-{i}",
                "tool": "communication", "action": "whatsapp_qr",
                "bot_id": self.bot_id, "thread_id": self.bot_id,
                "arguments": {"mensaje": f"mensaje {i}", "password": "fixture-secret"},
                "target": {"owner_phone_number": "+34612345678"}, "result_summary": {"secret": "fixture-secret"},
            })
        self.storage.add_audit_event({
            "event": "action.completed", "request_id": "req-other", "tool": "communication",
            "action": "whatsapp_qr", "bot_id": "other-bot", "thread_id": "other-bot",
            "arguments": {"mensaje": "mensaje privado de otro Dot"},
        })
        context = recent_whatsapp_actions(self.bot_id)
        self.assertEqual(context, [{"status": "accepted", "message": f"mensaje {i}"} for i in range(2, 5)])
        encoded = json.dumps(context)
        self.assertNotIn("fixture-secret", encoded)
        self.assertNotIn("+34612345678", encoded)
        self.assertNotIn("otro Dot", encoded)

    async def test_failed_send_is_not_presented_as_accepted_or_pending_approval(self):
        self.storage.add_audit_event({
            "event": "action.failed", "request_id": "req-failed", "tool": "communication",
            "action": "whatsapp_qr", "bot_id": self.bot_id, "thread_id": self.bot_id,
            "arguments": {"mensaje": "2 + 2 = 4"},
        })
        self.assertEqual(recent_whatsapp_actions(self.bot_id), [{"status": "failed", "message": "2 + 2 = 4"}])


if __name__ == "__main__":
    unittest.main()
