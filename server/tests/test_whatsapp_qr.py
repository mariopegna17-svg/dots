import tempfile
import asyncio
import socket
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from app.main import app
from app.services.auth_service import auth_service
from app.services.communication_service import CommunicationService, CommunicationError
from app.services.storage_service import StorageService
from app.services.whatsapp_qr_service import WhatsAppQRService, WhatsAppQRSettings


class WhatsAppQRTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.communications = CommunicationService(self.storage)
        self.service = WhatsAppQRService(self.storage, self.communications)
        self.service.available = True
        self.bot_id = self.storage.get_bots()[0]['id']
        self.config = WhatsAppQRSettings(bot_id=self.bot_id)
        self.bridge = AsyncMock(return_value={'state': 'connected', 'qr': None, 'account_phone': '+34612345678'})
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
                response = await client.post(f'http://127.0.0.1:{service.port}/connect', headers={'Authorization': 'Bearer ' + service.token}, json={'mode': 'everyone'})
                self.assertEqual(response.status_code, 409)
            self.assertEqual((await service.status())['state'], 'disconnected')
        finally:
            await service.stop()
        self.assertEqual(service.process.returncode, 0)
