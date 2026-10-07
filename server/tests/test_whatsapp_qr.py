import tempfile
import asyncio
import socket
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx

from app.main import app
from app.services.auth_service import auth_service
from app.services.communication_service import CommunicationService, CommunicationError
from app.services.storage_service import StorageService
from app.services.whatsapp_qr_service import WhatsAppQRService, WhatsAppQRSettings
from app.schemas.communications import CommunicationMessage
from app.services.communication_actions import prepare_communication_invocation, execute
from app.services.agent_service import run_agent
from app.services.action_gateway import ActionGateway, ActionGatewayError, action_gateway
from app.services.approval_broker import ApprovalBroker


class WhatsAppQRTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.communications = CommunicationService(self.storage)
        self.service = WhatsAppQRService(self.storage, self.communications)
        self.service.available = True
        self.bot_id = self.storage.get_bots()[0]['id']
        self.config = WhatsAppQRSettings(bot_id=self.bot_id)
        self.bridge = AsyncMock(return_value={'state': 'connected', 'qr': None, 'account_phone': '+34612345678', 'connection_id': 'fixture-session'})
        self.service.request = self.bridge
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1')
        self.auth = {'Authorization': 'Bearer ' + auth_service.token}
        self.patches = [patch('app.routers.whatsapp_qr.whatsapp_qr_service', self.service)]
        for item in self.patches: item.start()
        self.event = {'id': 'test-inbound-id', 'peer': '34612345678@s.whatsapp.net', 'text': 'Hola'}

    async def asyncTearDown(self):
        await self.client.aclose()
        for item in reversed(self.patches): item.stop()
        self.directory.cleanup()

    async def outbound_ready(self):
        state = {'state': 'connected', 'qr': None, 'account_phone': '+34612345678', 'connection_id': 'fixture-session'}
        def bridge(method, path, data=None):
            return {'id': 'fixture-sent-message', 'status': 'sent'} if path == '/send-owner' else state
        self.bridge.side_effect = bridge
        await self.service.connect(self.config)
        self.bridge.reset_mock()
        return state

    async def test_qr_and_controls_require_owner_login(self):
        root = '/api/v1/communications/whatsapp-qr'
        self.assertEqual((await self.client.get(root + '/status')).status_code, 401)
        for route in ['/connect', '/settings', '/disconnect']:
            self.assertEqual((await self.client.post(root + route, json=self.config.model_dump())).status_code, 401)
        self.bridge.assert_not_awaited()
        response = await self.client.get(root + '/status', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertNotIn(self.service.token, response.text)

    async def test_connect_persists_scope_and_default_dot_without_twilio(self):
        response = await self.client.post('/api/v1/communications/whatsapp-qr/connect', json=self.config.model_dump(), headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.service.config()['enabled'])
        self.assertFalse(self.communications.status()['whatsapp_ready'])
        self.assertEqual(self.service.config()['bot_id'], self.bot_id)
        reopened = WhatsAppQRService(StorageService(Path(self.directory.name)))
        self.assertEqual(reopened.config(), self.service.config())
        self.assertTrue(any(call.args[:2] == ('POST', '/connect') for call in self.bridge.await_args_list))

    async def test_connect_rejects_wrong_number_dot_and_unexpected_fields(self):
        root = '/api/v1/communications/whatsapp-qr/connect'
        for extra in [{'mode': 'separate'}, {'mode': 'separate', 'owner_phone_number': '612345678'}, {'mode': 'everyone'}, {'to': '+34611111111'}]:
            response = await self.client.post(root, json={**self.config.model_dump(), **extra}, headers=self.auth)
            self.assertEqual(response.status_code, 422)
        response = await self.client.post(root, json={**self.config.model_dump(), 'bot_id': 'deleted'}, headers=self.auth)
        self.assertEqual(response.status_code, 409)
        self.bridge.assert_not_awaited()

    async def test_real_answer_pipeline_uses_dot_memory_and_sends_once(self):
        await self.service.connect(self.config)
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            yield {'type': 'content.delta', 'delta': 'Hola, estoy aquí.'}
            yield {'type': 'turn.completed', 'ok': True}
        self.bridge.reset_mock()
        self.bridge.return_value = {'id': 'outbound-reply-id', 'status': 'sent'}
        with patch('app.services.communication_service.provider_service.stream_chat_completion', provider), patch('app.services.communication_service.memory_service.context', return_value='Recuerda: le gusta la música.'):
            await self.service.handle(self.event)
            await self.service.handle(self.event)
        self.assertEqual(len(captured), 1)
        self.assertNotIn('tools', captured[0])
        self.assertIn('le gusta la música', captured[0]['system_prompt'])
        replies = [call for call in self.bridge.await_args_list if call.args[:2] == ('POST', '/reply')]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0].args[2]['text'], 'Hola, estoy aquí.')
        event = self.communications.recent()[0]
        self.assertEqual(event['status'], 'sent')
        self.assertEqual(event['provider'], 'qr')
        self.assertEqual(event['reply'], 'Hola, estoy aquí.')

    async def test_disconnect_during_inference_prevents_send(self):
        await self.service.connect(self.config)
        async def answer(*args):
            await self.service.disconnect()
            return 'Respuesta tardía'
        with patch.object(self.communications, 'answer', side_effect=answer):
            await self.service.handle(self.event)
        self.assertFalse(self.service.config()['enabled'])
        self.assertFalse(any(call.args[:2] == ('POST', '/reply') for call in self.bridge.await_args_list))
        self.assertEqual(self.communications.recent()[0]['status'], 'failed')

    async def test_inference_and_bridge_errors_are_visible_without_leaking_credentials(self):
        await self.service.connect(self.config)
        with patch.object(self.communications, 'answer', side_effect=RuntimeError('nvapi-private-secret')):
            await self.service.handle(self.event)
        self.assertNotIn('nvapi-private-secret', str(self.communications.recent()))
        self.assertEqual(self.communications.recent()[0]['status'], 'failed')
        with patch.object(self.communications, 'answer', return_value='Hola'):
            self.bridge.side_effect = [CommunicationError('El servicio de WhatsApp no responde.'), {'ok': True}]
            await self.service.handle({**self.event, 'id': 'another'})
        self.assertIn('WhatsApp no responde', self.communications.recent()[0]['error'])

    async def test_reopened_duplicate_and_interrupted_events_are_not_resent(self):
        await self.service.connect(self.config)
        with patch.object(self.communications, 'answer', return_value='Respuesta'):
            self.bridge.return_value = {'id': 'out'}
            await self.service.handle(self.event)
        reopened = WhatsAppQRService(self.storage, CommunicationService(self.storage))
        reopened.request = AsyncMock()
        await reopened.handle(self.event)
        reopened.request.assert_awaited_once_with('POST', '/ack', {'id': self.event['id']})

    async def test_inbound_daily_limit_blocks_model_and_acknowledges_queue(self):
        await self.service.connect(self.config)
        for index in range(40):
            self.communications.claim('count-' + str(index), 'whatsapp_in', {'message': 'Hola'})
        with patch.object(self.communications, 'answer', new_callable=AsyncMock) as answer:
            await self.service.handle(self.event)
        answer.assert_not_awaited()
        self.bridge.assert_any_await('POST', '/ack', {'id': self.event['id']})

    async def test_unavailable_service_gives_actionable_status(self):
        self.bridge.side_effect = CommunicationError('Falta instalar el servicio de WhatsApp.')
        response = await self.client.get('/api/v1/communications/whatsapp-qr/status', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['state'], 'unavailable')
        self.assertIn('instalar', response.json()['error'])

    async def test_web_send_uses_qr_without_twilio_and_persists_outbound_history(self):
        await self.outbound_ready()
        with patch('app.services.communication_actions.whatsapp_qr_service', self.service):
            invocation = await prepare_communication_invocation('whatsapp_owner', self.bot_id, '2+2=4')
            self.assertEqual(invocation.name, 'communication.whatsapp_qr')
            self.assertIn('+34612345678', invocation.preview)
            result = await execute(invocation)
            repeated = await execute(invocation)
            changed = CommunicationMessage(bot_id=self.bot_id, message='Texto distinto')
            with self.assertRaisesRegex(CommunicationError, 'otro mensaje'):
                await self.service.send_owner(changed, invocation.arguments['expected'], invocation.arguments['event_id'])
        self.assertEqual(result['provider'], 'qr')
        self.assertEqual(repeated['status'], 'sent')
        sends = [call for call in self.bridge.await_args_list if call.args[:2] == ('POST', '/send-owner')]
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0].args[2]['text'], '2+2=4')
        self.assertEqual(sends[0].args[2]['owner_phone_number'], '+34612345678')
        self.assertFalse(self.communications.status()['whatsapp_ready'])
        event = self.communications.recent()[0]
        self.assertEqual((event['channel'], event['status'], event['provider'], event['message']), ('whatsapp_out', 'sent', 'qr', '2+2=4'))

    async def test_web_send_cannot_bypass_approval_and_denial_dispatches_nothing(self):
        await self.outbound_ready()
        with patch('app.services.communication_actions.whatsapp_qr_service', self.service), patch('app.services.approval_broker.storage_service', self.storage):
            broker = ApprovalBroker()
            gateway = ActionGateway(approvals=broker, audit=self.storage)
            gateway.register_action(action_gateway.definitions['communication.whatsapp_qr'], execute)
            invocation = await prepare_communication_invocation('whatsapp_owner', self.bot_id, '2+2=4')
            request, approval = gateway.open(self.bot_id, self.bot_id, invocation)
            self.assertEqual(approval['arguments'], {'canal': 'WhatsApp por QR', 'destinatario': '+34612345678', 'mensaje': '2+2=4'})
            with self.assertRaises(ActionGatewayError): await gateway.execute(request)
            broker.resolve(request.request_id, 'deny')
            self.assertEqual(await gateway.wait_for_decision(request), 'deny')
            with self.assertRaises(ActionGatewayError): await gateway.execute(request)
        self.assertFalse(any(call.args[:2] == ('POST', '/send-owner') for call in self.bridge.await_args_list))

    async def test_changed_qr_session_after_approval_blocks_send(self):
        state = await self.outbound_ready()
        with patch('app.services.communication_actions.whatsapp_qr_service', self.service):
            invocation = await prepare_communication_invocation('whatsapp_owner', self.bot_id, '2+2=4')
            state['connection_id'] = 'replacement-session'
            with self.assertRaisesRegex(CommunicationError, 'han cambiado'): await execute(invocation)
        self.assertFalse(any(call.args[:2] == ('POST', '/send-owner') for call in self.bridge.await_args_list))
        self.assertEqual(self.communications.recent(), [])

    async def test_unconfirmed_web_send_is_sanitized_and_never_automatically_repeated(self):
        await self.outbound_ready()
        original = self.bridge.side_effect
        def failure(method, path, data=None):
            if path == '/send-owner': raise RuntimeError('fixture-private-bridge-secret')
            return original(method, path, data)
        with patch('app.services.communication_actions.whatsapp_qr_service', self.service):
            invocation = await prepare_communication_invocation('whatsapp_owner', self.bot_id, '2+2=4')
            self.bridge.side_effect = failure
            for _ in range(2):
                with self.assertRaises(CommunicationError) as raised: await execute(invocation)
                self.assertNotIn('fixture-private-bridge-secret', str(raised.exception))
        sends = [call for call in self.bridge.await_args_list if call.args[:2] == ('POST', '/send-owner')]
        self.assertEqual(len(sends), 1)
        self.assertEqual(self.communications.recent()[0]['status'], 'failed')

    async def test_qr_web_send_shares_daily_limit_with_twilio_and_never_changes_provider(self):
        await self.outbound_ready()
        for index in range(10):
            self.communications.claim('out-' + str(index), 'voice_out', {'message': 'fixture'}, outbound=True)
        with patch('app.services.communication_actions.whatsapp_qr_service', self.service):
            invocation = await prepare_communication_invocation('whatsapp_owner', self.bot_id, '2+2=4')
            with self.assertRaisesRegex(CommunicationError, 'límite diario'): await execute(invocation)
        self.assertFalse(any(call.args[:2] == ('POST', '/send-owner') for call in self.bridge.await_args_list))

    async def test_model_with_only_gmail_in_composio_can_discover_and_send_via_connected_qr(self):
        await self.outbound_ready()
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            names = {tool['function']['name'] for tool in kwargs['tools']}
            self.assertIn('whatsapp_owner', names)
            self.assertIn('communication_status', names)
            self.assertNotIn(self.service.token, kwargs['system_prompt'])
            self.assertNotIn('connection_id', kwargs['system_prompt'])
            step = len(captured)
            if step < 3:
                if step == 2:
                    apps = json.loads(kwargs['messages'][-1]['content'])
                    self.assertEqual(apps['apps'][0]['slug'], 'gmail')
                    self.assertEqual(apps['whatsapp']['provider'], 'qr')
                    self.assertTrue(apps['whatsapp']['ready'])
                name = 'connector_list_apps' if step == 1 else 'whatsapp_owner'
                args = {} if step == 1 else {'message': '2+2=4'}
                yield {'type': 'tool.call', 'calls': [{'id': 'fixture-call-' + str(step), 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}
            else:
                result = json.loads(kwargs['messages'][-1]['content'])
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(result['result']['provider'], 'qr')
                yield {'type': 'content.delta', 'delta': 'WhatsApp ha aceptado el mensaje: 2+2=4.'}
                yield {'type': 'turn.completed', 'ok': True}
        broker = ApprovalBroker()
        gateway = ActionGateway(approvals=broker, audit=self.storage)
        gateway.register_action(action_gateway.definitions['communication.whatsapp_qr'], execute)
        with patch('app.services.agent_service.storage_service', self.storage), patch('app.services.agent_service.communication_service', self.communications), \
             patch('app.services.communication_actions.whatsapp_qr_service', self.service), patch('app.services.agent_service.action_gateway', gateway), \
             patch('app.services.approval_broker.storage_service', self.storage), patch('app.services.agent_service.provider_service.stream_chat_completion', provider), \
             patch('app.services.agent_service.connected_tools.connectors.key', return_value='fixture-composio-key'), \
             patch('app.services.agent_service.connected_tools.apps', new=AsyncMock(return_value={'configured': True, 'apps': [{'slug': 'gmail', 'active_accounts': 1}]})):
            events = []
            async for event in run_agent(self.bot_id, 'fixture-model', [{'role': 'user', 'content': 'Escríbeme a mi WhatsApp cuánto es 2+2; ya está activado por QR.'}], ''):
                events.append(event)
                if event['type'] == 'request.opened':
                    self.assertIn('2+2=4', event['summary'])
                    broker.resolve(event['requestId'], 'allow')
        self.assertEqual(len(captured), 3)
        self.assertTrue(events[-1]['ok'])
        self.assertEqual(len([call for call in self.bridge.await_args_list if call.args[:2] == ('POST', '/send-owner')]), 1)

    async def test_enabled_but_disconnected_qr_explains_actual_state_and_hides_send_tool(self):
        state = await self.outbound_ready()
        state['state'] = 'reconnecting'
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.storage_service', self.storage), patch('app.services.agent_service.communication_service', self.communications), \
             patch('app.services.communication_actions.whatsapp_qr_service', self.service), patch('app.services.agent_service.provider_service.stream_chat_completion', provider):
            [event async for event in run_agent(self.bot_id, 'fixture', [], '')]
            with self.assertRaisesRegex(CommunicationError, 'reconnecting'):
                await prepare_communication_invocation('whatsapp_owner', self.bot_id, '2+2=4')
        names = {tool['function']['name'] for tool in captured[0]['tools']}
        self.assertNotIn('whatsapp_owner', names)
        self.assertIn('communication_status', names)
        self.assertIn('reconnecting', captured[0]['system_prompt'])

    async def test_real_private_bridge_starts_stops_and_suppresses_sensitive_library_logs(self):
        service = WhatsAppQRService(self.storage, self.communications)
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            service.port = listener.getsockname()[1]
        spawn = asyncio.create_subprocess_exec
        try:
            with patch('app.services.whatsapp_qr_service.asyncio.create_subprocess_exec', wraps=spawn) as launch:
                await service.start()
            self.assertTrue(service.available)
            self.assertEqual((await service.status())['state'], 'disconnected')
            self.assertEqual(launch.call_args.kwargs['stdout'], asyncio.subprocess.DEVNULL)
            self.assertEqual(launch.call_args.kwargs['stderr'], asyncio.subprocess.DEVNULL)
            async with httpx.AsyncClient(trust_env=False) as client:
                response = await client.get(f'http://127.0.0.1:{service.port}/status')
                self.assertEqual(response.status_code, 401)
                response = await client.post(f'http://127.0.0.1:{service.port}/send-owner', json={'text': '2+2=4'})
                self.assertEqual(response.status_code, 401)
                response = await client.post(f'http://127.0.0.1:{service.port}/send-owner', headers={'Authorization': 'Bearer ' + service.token}, json={'text': '2+2=4'})
                self.assertEqual(response.status_code, 409)
                response = await client.post(f'http://127.0.0.1:{service.port}/connect', headers={'Authorization': 'Bearer ' + service.token}, json={'mode': 'everyone'})
                self.assertEqual(response.status_code, 409)
            self.assertEqual((await service.status())['state'], 'disconnected')
        finally:
            await service.stop()
        self.assertEqual(service.process.returncode, 0)

    def private_service(self, storage=None):
        storage = storage or self.storage
        service = WhatsAppQRService(storage, CommunicationService(storage))
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            service.port = listener.getsockname()[1]
        return service

    def delayed_spawn(self, delay):
        spawn = asyncio.create_subprocess_exec
        async def launch(node, script, **kwargs):
            # Delay the real entrypoint without loading or connecting an account.
            source = f'await new Promise(resolve => setTimeout(resolve, {delay})); await import(process.argv[1]);'
            return await spawn(node, '--input-type=module', '-e', source, str(Path(script).as_uri()), **kwargs)
        return launch

    async def test_real_bridge_can_take_longer_than_four_seconds_to_start(self):
        service = self.private_service()
        service.startup_timeout = 10
        try:
            with patch('app.services.whatsapp_qr_service.asyncio.create_subprocess_exec', side_effect=self.delayed_spawn(4500)) as spawn:
                await service.start()
                self.assertTrue(service.available)
                self.assertEqual((await service.status())['state'], 'disconnected')
                self.assertTrue(await service.launch())
                self.assertEqual(spawn.await_count, 1)
        finally:
            await service.stop()

    async def test_live_bridge_recovers_after_initial_timeout_without_second_process(self):
        service = self.private_service()
        service.startup_timeout = 0.1
        try:
            with patch('app.services.whatsapp_qr_service.asyncio.create_subprocess_exec', side_effect=self.delayed_spawn(1000)) as spawn:
                await service.start()
                self.assertFalse(service.available)
                original_pid = service.process.pid
                deadline = asyncio.get_running_loop().time() + 6
                while not service.available and asyncio.get_running_loop().time() < deadline:
                    await asyncio.sleep(0.05)
                self.assertTrue(service.available)
                self.assertEqual(service.error, '')
                self.assertEqual((await service.status())['state'], 'disconnected')
                self.assertEqual(service.process.pid, original_pid)
                self.assertEqual(spawn.await_count, 1)
                self.assertEqual(service.restart_count, 0)
        finally:
            await service.stop()

    async def test_saved_session_errors_are_specific_and_do_not_overwrite_credentials(self):
        for code, key in ((21, None), (22, b'bad-key'), (23, b'x' * 32)):
            with self.subTest(code=code):
                storage = StorageService(Path(self.directory.name) / str(code))
                directory = storage.data_dir / 'whatsapp'
                directory.mkdir()
                encrypted = b'fixture-invalid-encrypted-session-do-not-overwrite'
                (directory / 'session.enc').write_bytes(encrypted)
                if key is not None:
                    (directory / 'session.key').write_bytes(key)
                service = self.private_service(storage)
                try:
                    with self.assertLogs('uvicorn.error', level='WARNING') as logs:
                        await service.start()
                    self.assertFalse(service.available)
                    self.assertEqual(service.process.returncode, code)
                    self.assertIn('sesión', (await service.status())['error'])
                    self.assertIn('no borres', service.error)
                    await asyncio.sleep(0.05)
                    self.assertEqual(service.restart_count, 0)
                    self.assertEqual((directory / 'session.enc').read_bytes(), encrypted)
                    self.assertEqual((directory / 'session.key').read_bytes() if (directory / 'session.key').exists() else None, key)
                    self.assertNotIn(encrypted.decode(), '\n'.join(logs.output))
                    self.assertNotIn(service.token, '\n'.join(logs.output))
                finally:
                    await service.stop()

    async def test_occupied_private_port_has_actionable_error(self):
        service = self.private_service()
        try:
            with socket.socket() as occupied:
                occupied.bind(('127.0.0.1', service.port))
                occupied.listen()
                await service.start()
                self.assertFalse(service.available)
                self.assertEqual(service.process.returncode, 25)
                self.assertIn('ocupado', service.error)
        finally:
            await service.stop()

    async def test_recovered_bridge_resumes_saved_scope_once(self):
        service = self.private_service()
        service.process = SimpleNamespace(returncode=None)
        self.storage.save_settings({'whatsapp_qr_enabled': True, 'whatsapp_qr_mode': 'separate', 'whatsapp_qr_owner_phone_number': '+34699999999'})
        calls = []
        state = {'state': 'disconnected', 'connection_id': 'fixture-session', 'qr': None, 'error': ''}
        def transport(request):
            self.assertEqual(request.headers['authorization'], 'Bearer ' + service.token)
            calls.append(request)
            return httpx.Response(200, json=state)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{service.port}', headers={'Authorization': 'Bearer ' + service.token}, transport=httpx.MockTransport(transport)) as client:
            service.client = client
            service.error = 'Previous startup timeout'
            self.assertTrue(await service.probe_ready())
            self.assertTrue(await service.probe_ready())
            connects = [request for request in calls if request.url.path == '/connect']
            self.assertEqual(len(connects), 1)
            self.assertEqual(json.loads(connects[0].content), {'mode': 'separate', 'owner_phone_number': '+34699999999'})
            self.assertEqual(service.error, '')

    async def test_ready_check_requires_valid_private_bridge_response(self):
        service = self.private_service()
        service.process = SimpleNamespace(returncode=None)
        for payload in ([], {'state': []}, {'state': 'connected'}, {'state': 'connected', 'connection_id': ''}, {'state': 'unrelated', 'connection_id': 'fixture-session'}):
            async with httpx.AsyncClient(base_url='http://127.0.0.1', transport=httpx.MockTransport(lambda request: httpx.Response(200, json=payload))) as client:
                service.client = client
                self.assertFalse(await service.probe_ready())
                self.assertFalse(service.available)

    async def test_failed_session_resume_keeps_bridge_usable_for_manual_connect(self):
        service = self.private_service()
        service.process = SimpleNamespace(returncode=None)
        self.storage.save_settings({'whatsapp_qr_enabled': True})
        state = {'state': 'disconnected', 'connection_id': 'fixture-session', 'qr': None, 'error': ''}
        fail_connect = True
        def transport(request):
            return httpx.Response(409 if request.url.path == '/connect' and fail_connect else 200, json=state)
        async with httpx.AsyncClient(base_url='http://127.0.0.1', transport=httpx.MockTransport(transport)) as client:
            service.client = client
            self.assertTrue(await service.probe_ready())
            self.assertTrue(service.available)
            self.assertIn('Pulsa Conectar WhatsApp', (await service.status())['error'])
            fail_connect = False
            result = await service.connect(self.config)
            self.assertTrue(result['available'])
            self.assertEqual(result['error'], '')
