import asyncio
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.services.action_gateway import ActionGateway, ActionDefinition, ActionInvocation, action_gateway
from app.services.agent_service import run_agent, recent_history
from app.services.approval_broker import ApprovalBroker
from app.services.communication_actions import execute, prepare_communication_invocation
from app.services.communication_service import CommunicationError, CommunicationService
from app.services.memory_service import MemoryService
from app.services.provider_service import ModelProviderService
from app.services.storage_service import StorageService
from app.services.whatsapp_qr_service import WhatsAppQRService, WhatsAppQRSettings


class CommunicationProfileTests(unittest.IsolatedAsyncioTestCase):
    async def provider_request(self, *, profile='default', model='nvidia/nemotron-3-super-120b-a12b', base='https://integrate.api.nvidia.com/v1', wire='chat_completions', tools=None, tool_choice='auto'):
        captured = []
        def transport(request):
            captured.append(json.loads(request.content))
            events = [{'type': 'response.output_text.delta', 'delta': '4'}, {'type': 'response.completed'}] if wire == 'responses' else [
                {'choices': [{'delta': {'content': '4'}}]},
                {'choices': [{'delta': {}, 'finish_reason': 'stop'}]},
            ]
            return httpx.Response(200, text=''.join('data: ' + json.dumps(event) + '\n\n' for event in events) + 'data: [DONE]\n\n')
        client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
        config = {'model_api_key': 'fixture-private-key', 'model_api_base_url': base, 'model_api_wire_api': wire}
        with patch('app.services.provider_service.storage_service.get_settings', return_value=config), patch('app.services.provider_service.httpx.AsyncClient', return_value=client):
            events = [event async for event in ModelProviderService().stream_chat_completion(model, [{'role': 'user', 'content': '2+2'}], response_profile=profile, tools=tools, tool_choice=tool_choice)]
        self.assertEqual(events[0]['delta'], '4')
        self.assertTrue(events[-1]['ok'])
        self.assertEqual(captured[0]['model'], model)
        return captured[0]

    async def test_default_analysis_retains_generation_budget_and_thinking_configuration(self):
        body = await self.provider_request()
        self.assertEqual(body['max_tokens'], 8192)
        self.assertNotIn('chat_template_kwargs', body)

    async def test_short_communication_uses_documented_non_thinking_nvidia_template(self):
        body = await self.provider_request(profile='communication')
        self.assertEqual(body['max_tokens'], 1024)
        self.assertEqual(body['chat_template_kwargs'], {'enable_thinking': False})

    async def test_other_models_and_custom_endpoints_do_not_receive_nvidia_extensions(self):
        for options in ({'model': 'meta/llama-3.3-70b-instruct'}, {'base': 'https://custom.example/v1'}):
            body = await self.provider_request(profile='communication', **options)
            self.assertEqual(body['max_tokens'], 1024)
            self.assertNotIn('chat_template_kwargs', body)

    async def test_responses_protocol_uses_its_own_output_limit(self):
        body = await self.provider_request(profile='communication', wire='responses')
        self.assertEqual(body['max_output_tokens'], 1024)
        self.assertNotIn('max_tokens', body)
        self.assertNotIn('chat_template_kwargs', body)

    async def test_required_tool_choice_reaches_provider_and_default_remains_auto(self):
        tools = [{'type': 'function', 'function': {'name': 'fixture-action', 'parameters': {'type': 'object'}}}]
        body = await self.provider_request(tools=tools, tool_choice='required')
        self.assertEqual(body['tool_choice'], 'required')
        body = await self.provider_request(tools=tools)
        self.assertEqual(body['tool_choice'], 'auto')
        body = await self.provider_request(tool_choice='required')
        self.assertNotIn('tool_choice', body)

    async def test_interactive_fast_profile_keeps_exact_model_and_supports_longer_answers(self):
        body = await self.provider_request(profile='interactive')
        self.assertEqual(body['max_tokens'], 4096)
        self.assertEqual(body['chat_template_kwargs'], {'enable_thinking': False})
        body = await self.provider_request(profile='interactive', model='custom/exact-model')
        self.assertEqual(body['max_tokens'], 4096)
        self.assertNotIn('chat_template_kwargs', body)

    async def test_interactive_responses_uses_protocol_correct_budget(self):
        body = await self.provider_request(profile='interactive', wire='responses')
        self.assertEqual(body['max_output_tokens'], 4096)
        self.assertNotIn('chat_template_kwargs', body)


class WhatsAppTurnLatencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.storage.save_settings({'whatsapp_send_mode': 'review'})
        self.bot_id = self.storage.get_bots()[0]['id']
        self.communications = CommunicationService(self.storage)
        self.qr = WhatsAppQRService(self.storage, self.communications)
        self.qr.available = True
        self.send_error = False
        state = {'state': 'connected', 'qr': None, 'account_phone': '+34612345678', 'connection_id': 'fixture-session'}
        def bridge(method, path, data=None):
            if path == '/send-owner':
                if self.send_error:
                    raise CommunicationError('No se pudo confirmar el envío. Revisa WhatsApp antes de repetirlo.')
                return {'id': 'fixture-sent', 'status': 'sent'}
            return state
        self.qr.request = AsyncMock(side_effect=bridge)
        await self.qr.connect(WhatsAppQRSettings(bot_id=self.bot_id))
        self.qr.request.reset_mock()
        self.broker = ApprovalBroker()
        self.gateway = ActionGateway(approvals=self.broker, audit=self.storage)
        self.gateway.register_action(action_gateway.definitions['communication.whatsapp_qr'], execute)
        self.calls = []
        self.arguments = {'message': '2+2=4', 'final_action': True}
        self.follow_up = None
        self.batched = False
        async def provider(**kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                calls = [{'id': 'fixture-tool-call', 'type': 'function', 'function': {'name': 'whatsapp_owner', 'arguments': json.dumps(self.arguments)}}]
                if self.batched:
                    calls.insert(0, {'id': 'fixture-status', 'type': 'function', 'function': {'name': 'communication_status', 'arguments': '{}'}})
                    calls.append({'id': 'fixture-remember', 'type': 'function', 'function': {'name': 'remember', 'arguments': json.dumps({'text': 'No debe ejecutarse después del rechazo.'})}})
                yield {'type': 'tool.call', 'calls': calls}
            else:
                self.assertIsNotNone(self.follow_up, 'A second inference request delayed a finished WhatsApp action')
                yield {'type': 'content.delta', 'delta': self.follow_up}
                yield {'type': 'turn.completed', 'ok': True}
        self.patches = ExitStack()
        for target, value in [
            ('app.services.agent_service.storage_service', self.storage),
            ('app.services.agent_service.memory_service', MemoryService(self.storage)),
            ('app.services.agent_service.communication_service', self.communications),
            ('app.services.communication_actions.whatsapp_qr_service', self.qr),
            ('app.services.agent_service.action_gateway', self.gateway),
            ('app.services.approval_broker.storage_service', self.storage),
            ('app.services.agent_service.provider_service.stream_chat_completion', provider),
        ]:
            self.patches.enter_context(patch(target, value))

    async def asyncTearDown(self):
        self.patches.close()
        self.directory.cleanup()

    def sends(self):
        return [call for call in self.qr.request.await_args_list if call.args[:2] == ('POST', '/send-owner')]

    async def turn(self, decision='allow', text='Envíame por WhatsApp cuánto es 2+2.'):
        events = []
        async for event in run_agent(self.bot_id, 'fixture-model', [{'role': 'user', 'content': text}], ''):
            events.append(event)
            if event['type'] == 'request.opened':
                self.assertEqual(len(self.sends()), 0)
                self.assertIn('2+2=4', event['summary'])
                if decision:
                    self.broker.resolve(event['requestId'], decision)
        return events

    async def test_final_send_confirms_actual_result_without_second_inference_request(self):
        events = await self.turn()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]['response_profile'], 'communication')
        self.assertEqual(self.calls[0]['tool_choice'], 'required')
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(events[-1], {'type': 'turn.completed', 'ok': True})
        self.assertIn('aceptado', events[-2]['delta'])
        self.assertIn('todavía no está confirmada', events[-2]['delta'])

    async def test_owner_automatic_mode_sends_once_without_a_pending_card_or_expiry(self):
        self.storage.save_settings({'whatsapp_send_mode': 'automatic'})
        self.arguments.pop('final_action')
        events = await self.turn(decision=None)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.sends()), 1)
        self.assertFalse(any(event['type'] == 'request.opened' for event in events))
        self.assertEqual(self.broker.pending, {})
        self.assertTrue(events[-1]['ok'])
        self.assertIn('ha elegido envío automático', self.calls[0]['system_prompt'])
        automatic = [item for item in self.storage.get_audit_events() if item.get('event') == 'action.approved']
        self.assertEqual(automatic[0]['approval_policy'], 'owner_whatsapp_preference')
        self.assertFalse(automatic[0]['requires_approval'])
        self.assertNotIn('approval', [event.get('stage') for event in events if event['type'] == 'turn.progress'])

    async def test_simple_automatic_batch_finishes_after_first_owner_send_without_duplicate_or_inference(self):
        self.storage.save_settings({'whatsapp_send_mode': 'automatic'})
        async def provider(**kwargs):
            self.calls.append(kwargs)
            self.assertEqual(len(self.calls), 1)
            yield {'type': 'tool.call', 'calls': [
                {'id': 'fixture-status', 'type': 'function', 'function': {'name': 'communication_status', 'arguments': '{}'}},
                *[{'id': f'fixture-owner-{i}', 'type': 'function', 'function': {'name': 'whatsapp_owner', 'arguments': json.dumps({'message': '2+2=4'})}} for i in range(2)],
            ]}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            events = await self.turn(decision=None)
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(events[-1]['ok'])
        self.assertFalse(any(event['type'] == 'request.opened' for event in events))

    async def test_non_final_duplicate_text_is_not_redispatched_even_after_an_uncertain_send(self):
        self.storage.save_settings({'whatsapp_send_mode': 'automatic'})
        self.send_error = True
        async def provider(**kwargs):
            self.calls.append(kwargs)
            if len(self.calls) == 1:
                yield {'type': 'tool.call', 'calls': [{'id': f'fixture-owner-{i}', 'type': 'function', 'function': {'name': 'whatsapp_owner', 'arguments': json.dumps({'message': '2+2=4', 'final_action': False})}} for i in range(2)]}
            else:
                yield {'type': 'content.delta', 'delta': 'Revisa WhatsApp: no se confirmó el envío y no lo he repetido.'}
                yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            events = await self.turn(decision=None)
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(len(self.calls), 2)
        failures = [event for event in events if event['type'] == 'tool.failed']
        self.assertTrue(any('No se repetirá automáticamente' in event.get('error', '') for event in failures))

    async def test_automatic_mode_cannot_disable_review_for_other_tools_or_from_model_arguments(self):
        self.storage.save_settings({'whatsapp_send_mode': 'automatic'})
        for name in ('communication.voice', 'connector.send_email', 'youtube.publish', 'workspace.write'):
            tool, action = name.split('.', 1)
            self.gateway.register_action(ActionDefinition(name, tool, action, 'Acción de prueba', 'external', True), AsyncMock(return_value={'ok': True}))
            request, approval = self.gateway.open(self.bot_id, self.bot_id, ActionInvocation(name, {'whatsapp_send_mode': 'automatic', 'requires_approval': False}, {'owner_phone_number': '+34612345678'}, 'Acción de prueba'))
            self.assertTrue(request.requires_approval)
            self.assertIsNotNone(approval)
            self.gateway.cancel_pending(request)
        self.assertEqual(len(self.sends()), 0)

    async def test_model_arguments_cannot_override_saved_review_policy(self):
        invocation = await prepare_communication_invocation('whatsapp_owner', self.bot_id, '2+2=4')
        invocation.arguments['requires_approval'] = False
        invocation.arguments['whatsapp_send_mode'] = 'automatic'
        request, approval = self.gateway.open(self.bot_id, self.bot_id, invocation)
        self.assertTrue(request.requires_approval)
        self.assertIsNotNone(approval)
        self.gateway.cancel_pending(request)
        self.assertEqual(len(self.sends()), 0)

    async def test_simple_send_does_not_wait_for_another_model_call_when_final_flag_is_omitted(self):
        self.arguments.pop('final_action')
        events = await self.turn()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.sends()), 1)
        self.assertIn('aceptado', events[-2]['delta'])
        self.assertEqual([event['stage'] for event in events if event['type'] == 'turn.progress'], ['preparing', 'generating', 'approval', 'sending'])

    async def test_missing_flag_on_a_multi_task_request_can_continue_after_send(self):
        self.arguments.pop('final_action')
        self.follow_up = 'También he preparado la explicación solicitada.'
        events = await self.turn(text='Envíame por WhatsApp cuánto es 2+2 y explica cómo calcularlo aquí.')
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(events[-2]['delta'], self.follow_up)

    async def test_slow_generation_ends_without_opening_permission_or_dispatching(self):
        cancelled = False
        async def stalled_provider(**kwargs):
            nonlocal cancelled
            try:
                await asyncio.Event().wait()
                yield {'type': 'turn.completed', 'ok': True}
            finally:
                cancelled = True
        with patch('app.services.agent_service.provider_service.stream_chat_completion', stalled_provider), patch('app.services.agent_service.COMMUNICATION_GENERATION_TIMEOUT', 0.01):
            events = await self.turn()
        self.assertTrue(cancelled)
        self.assertIn('tardando demasiado', events[-2]['delta'])
        self.assertFalse(events[-1]['ok'])
        self.assertEqual(len(self.sends()), 0)
        self.assertEqual(self.broker.pending, {})

    async def test_review_time_is_not_counted_as_generation_time(self):
        resolver = None
        async def approve_later(request_id):
            await asyncio.sleep(0.03)
            self.broker.resolve(request_id, 'allow')
        events = []
        with patch('app.services.agent_service.COMMUNICATION_GENERATION_TIMEOUT', 0.01):
            async for event in run_agent(self.bot_id, 'fixture-model', [{'role': 'user', 'content': 'Envíame por WhatsApp cuánto es 2+2.'}], ''):
                events.append(event)
                if event['type'] == 'request.opened':
                    resolver = asyncio.create_task(approve_later(event['requestId']))
            await resolver
        self.assertEqual(len(self.sends()), 1)
        self.assertTrue(events[-1]['ok'])

    async def test_closing_chat_at_permission_card_expires_proposal_and_cannot_send(self):
        stream = run_agent(self.bot_id, 'fixture-model', [{'role': 'user', 'content': 'Envíame por WhatsApp cuánto es 2+2.'}], '')
        request_id = None
        async for event in stream:
            if event['type'] == 'request.opened':
                request_id = event['requestId']
                break
        await stream.aclose()
        self.assertEqual(self.broker.pending, {})
        self.assertIsNone(self.gateway.get_pending_request(request_id))
        self.assertFalse(self.broker.resolve(request_id, 'allow'))
        self.assertEqual(self.storage.get_approvals()[-1]['status'], 'expired')
        self.assertEqual(len(self.sends()), 0)

    async def test_cancelling_while_waiting_for_review_closes_saved_pending_state(self):
        opened = asyncio.Event()
        async def consume():
            async for event in run_agent(self.bot_id, 'fixture-model', [{'role': 'user', 'content': 'Envíame por WhatsApp cuánto es 2+2.'}], ''):
                if event['type'] == 'request.opened':
                    opened.set()
        task = asyncio.create_task(consume())
        await opened.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.broker.pending, {})
        approval = self.storage.get_approvals()[-1]
        self.assertEqual(approval['status'], 'expired')
        self.assertIsNone(self.gateway.get_pending_request(approval['request_id']))
        self.assertEqual(len(self.sends()), 0)

    async def test_normal_chat_is_fast_by_default_and_reasoned_mode_remains_available(self):
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            yield {'type': 'content.delta', 'delta': 'Hola.'}
            yield {'type': 'turn.completed', 'ok': True}
        messages = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': str(i) + 'x' * 1000} for i in range(60)] + [{'role': 'user', 'content': 'Hola', 'image_url': 'data:image/png;base64,fixture'}]
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            await self.turn(text='Hola')
            self.assertEqual(captured[-1]['response_profile'], 'interactive')
            [event async for event in run_agent(self.bot_id, 'fixture-model', messages, 'Persona')]
            self.assertLessEqual(len(captured[-1]['messages']), 24)
            self.assertEqual(captured[-1]['messages'][-1], messages[-1])
            self.storage.save_settings({'model_response_mode': 'reasoned'})
            events = [event async for event in run_agent(self.bot_id, 'fixture-model', messages, 'Persona')]
        self.assertNotIn('response_profile', captured[-1])
        self.assertEqual(captured[-1]['messages'], messages)
        self.assertTrue(events[-1]['ok'])

    async def test_voice_uses_short_generation_and_real_tools_with_review(self):
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            yield {'type': 'content.delta', 'delta': 'Hola, ¿cómo estás?'}
            yield {'type': 'turn.completed', 'ok': True}
        self.storage.save_settings({'model_response_mode': 'reasoned'})
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            events = [event async for event in run_agent(self.bot_id, 'fixture-model', [{'role': 'user', 'content': 'Hola'}], '', response_mode='voice')]
        self.assertEqual(captured[0]['response_profile'], 'communication')
        self.assertIn('una a cuatro frases', captured[0]['system_prompt'])
        self.assertIn('hablar no equivale a autorizar', captured[0]['system_prompt'])
        self.assertIn('whatsapp_owner', [tool['function']['name'] for tool in captured[0]['tools']])
        self.assertTrue(events[-1]['ok'])

    async def test_common_spanish_spellings_of_whatsapp_use_the_same_fast_path(self):
        for channel in ('whatshapp', 'wasap', 'whats app'):
            with self.subTest(channel=channel):
                self.calls.clear()
                self.qr.request.reset_mock()
                await self.turn(text=f'Envíame por {channel} cuánto es 2+2.')
                self.assertEqual(len(self.calls), 1)
                self.assertEqual(self.calls[0]['response_profile'], 'communication')

    async def test_expired_permission_ends_promptly_and_points_to_a_new_card_in_this_chat(self):
        with patch('app.services.approval_broker.settings.APPROVAL_TIMEOUT_SECONDS', 0.01):
            events = await self.turn(decision=None)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.sends()), 0)
        self.assertTrue(any(event['type'] == 'tool.expired' for event in events))
        self.assertIn('caducó', events[-2]['delta'])
        self.assertIn('este chat', events[-2]['delta'])
        self.assertEqual(self.broker.pending, {})

    async def test_denial_does_not_retry_inference_or_send_via_another_channel(self):
        events = await self.turn(decision='deny')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.sends()), 0)
        self.assertIn('rechazado', events[-2]['delta'])

    async def test_uncertain_send_does_not_retry_or_claim_success(self):
        self.send_error = True
        events = await self.turn()
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.sends()), 1)
        self.assertFalse(events[-1]['ok'])
        self.assertTrue(any(event['type'] == 'tool.failed' for event in events))

    async def test_batched_whatsapp_denial_ends_before_more_tools_or_inference(self):
        self.batched = True
        self.arguments.pop('final_action')
        events = await self.turn(decision='deny')
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.sends()), 0)
        self.assertIn('rechazado', events[-2]['delta'])
        self.assertFalse(any(event.get('tool') == 'remember' for event in events))
        self.assertEqual(self.broker.pending, {})

    async def test_batched_whatsapp_expiry_does_not_ask_model_to_explain_old_history(self):
        self.batched = True
        self.arguments['final_action'] = False
        with patch('app.services.approval_broker.settings.APPROVAL_TIMEOUT_SECONDS', 0.01):
            events = await self.turn(decision=None)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(len(self.sends()), 0)
        self.assertIn('caducó', events[-2]['delta'])
        self.assertIn('este chat', events[-2]['delta'])
        self.assertNotIn('Llamadas y WhatsApp', events[-2]['delta'])
        self.assertNotIn('No se concedió permiso', events[-2]['delta'])
        self.assertFalse(any(event.get('tool') == 'remember' for event in events))
        self.assertEqual(self.broker.pending, {})

    async def test_non_final_send_can_continue_to_answer_the_rest_of_the_request(self):
        self.arguments['final_action'] = False
        self.follow_up = 'Ahora continúo con el resto de tu petición.'
        events = await self.turn()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(events[-2]['delta'], self.follow_up)
        self.assertEqual(self.calls[0]['tool_choice'], 'required')
        self.assertNotIn('tool_choice', self.calls[1])

    async def test_false_approval_instructions_cannot_replace_a_real_whatsapp_proposal(self):
        async def provider(**kwargs):
            self.assertEqual(kwargs['tool_choice'], 'required')
            yield {'type': 'content.delta', 'delta': 'Error: No se concedió permiso; la acción no se ejecutó. Ve a Llamadas y WhatsApp. Hay una ventana pendiente; recarga para autorizar.'}
            yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            events = await self.turn()
        text = ''.join(event.get('delta', '') for event in events)
        self.assertNotIn('Llamadas y WhatsApp', text)
        self.assertNotIn('recarga', text)
        self.assertNotIn('No se concedió permiso', text)
        self.assertIn('No hay una autorización pendiente', text)
        self.assertEqual(len(self.sends()), 0)
        self.assertEqual(self.broker.pending, {})
        self.assertFalse(events[-1]['ok'])

    async def test_provider_failure_is_preserved_when_a_real_proposal_was_required(self):
        async def provider(**kwargs):
            yield {'type': 'content.delta', 'delta': 'Inference HTTP 401. Check credentials.'}
            yield {'type': 'turn.completed', 'ok': False}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            events = await self.turn()
        self.assertIn('HTTP 401', events[-2]['delta'])
        self.assertEqual(len(self.sends()), 0)
        self.assertFalse(events[-1]['ok'])

    async def test_status_questions_negation_and_quotes_do_not_require_a_send_proposal(self):
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            yield {'type': 'content.delta', 'delta': 'Una respuesta informativa.'}
            yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            for text in ('¿Está conectado WhatsApp?', 'No me envíes nada por WhatsApp.', 'Repite «envíame por WhatsApp».', 'Si te digo envíame por WhatsApp, ¿qué ocurre?', 'Envíame por Gmail los datos de WhatsApp.', 'Envíame por Gmail, no por WhatsApp.'):
                events = await self.turn(text=text)
                self.assertNotIn('tool_choice', captured[-1])
                self.assertTrue(events[-1]['ok'])
        self.assertEqual(len(self.sends()), 0)

    async def test_unavailable_qr_and_background_do_not_require_an_owner_send_proposal(self):
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            yield {'type': 'content.delta', 'delta': 'No se ha propuesto un envío.'}
            yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            with patch('app.services.agent_service.communication_capabilities', new=AsyncMock(return_value={'voice': {'ready': False}, 'whatsapp': {'ready': False}})):
                await self.turn()
            events = [event async for event in run_agent(self.bot_id, 'fixture-model', [{'role': 'user', 'content': 'Envíame por WhatsApp cuánto es 2+2.'}], '', background=True)]
        self.assertEqual(len(captured), 2)
        for kwargs in captured:
            self.assertNotIn('tool_choice', kwargs)
            self.assertNotIn('whatsapp_owner', [tool['function']['name'] for tool in kwargs.get('tools', [])])
        self.assertTrue(events[-1]['ok'])
        self.assertEqual(len(self.sends()), 0)

    async def test_required_proposal_allows_reads_first_and_releases_choice_after_approval(self):
        async def provider(**kwargs):
            self.calls.append(kwargs)
            if len(self.calls) < 3:
                name = 'communication_status' if len(self.calls) == 1 else 'whatsapp_owner'
                args = {} if name == 'communication_status' else {'message': '2+2=4', 'final_action': False}
                yield {'type': 'content.delta', 'delta': 'Texto preliminar que no representa una aprobación.'}
                yield {'type': 'tool.call', 'calls': [{'id': f'fixture-{len(self.calls)}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}
            else:
                yield {'type': 'content.delta', 'delta': 'WhatsApp aceptó el envío.'}
                yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            events = await self.turn()
        self.assertEqual([call.get('tool_choice', 'auto') for call in self.calls], ['required', 'required', 'auto'])
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(sum(event['type'] == 'request.opened' for event in events), 1)
        self.assertNotIn('Texto preliminar', ''.join(event.get('delta', '') for event in events))

    async def test_incoming_whatsapp_answers_use_short_communication_profile(self):
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            yield {'type': 'content.delta', 'delta': '2+2=4'}
            yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.communication_service.provider_service.stream_chat_completion', provider), patch('app.services.communication_service.memory_service', MemoryService(self.storage)):
            reply = await self.communications.answer(self.bot_id, '2+2', 'fixture-incoming')
        self.assertEqual(reply, '2+2=4')
        self.assertEqual(captured[0]['response_profile'], 'communication')
        self.assertNotIn('tools', captured[0])


class RecentInferenceHistoryTests(unittest.TestCase):
    def test_recent_window_retains_persona_image_and_complete_latest_question(self):
        persona = {'role': 'system', 'content': 'Persona persistente.'}
        old = [{'role': 'user' if i % 2 == 0 else 'assistant', 'content': f'{i}: ' + 'x' * 1500} for i in range(60)]
        latest = {'role': 'user', 'content': 'Última pregunta sin recortar.', 'image_url': 'data:image/png;base64,fixture'}
        recent = recent_history([persona, *old, latest])
        self.assertIs(recent[0], persona)
        self.assertIs(recent[-1], latest)
        self.assertLessEqual(len(recent), 25)
        self.assertLessEqual(sum(len(message['content']) for message in recent[1:]), 24000)
        self.assertLess(len(recent), len(old))

    def test_a_large_latest_question_is_never_silently_cut(self):
        latest = {'role': 'user', 'content': 'x' * 30000}
        recent = recent_history([{'role': 'assistant', 'content': 'Viejo'}, latest])
        self.assertEqual(recent, [latest])
