import asyncio
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from app.services.action_gateway import ActionGateway, action_gateway
from app.services.agent_service import run_agent
from app.services.approval_broker import ApprovalBroker
from app.services.communication_actions import execute
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


class WhatsAppTurnLatencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
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
