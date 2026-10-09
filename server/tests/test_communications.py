import base64
import hashlib
import hmac
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode

import httpx

from app.main import app
from app.schemas.communications import CommunicationSettings, CommunicationMessage
from app.services.auth_service import auth_service
from app.services.storage_service import StorageService
from app.services.communication_service import CommunicationService, CommunicationError
from app.services.approval_broker import ApprovalBroker
from app.services.action_gateway import ActionGateway, ActionGatewayError, action_gateway
from app.services.communication_actions import communication_invocation, execute
from app.services.agent_service import run_agent


class CommunicationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.storage.save_settings({'whatsapp_send_mode': 'review'})
        self.service = CommunicationService(self.storage)
        self.bot_id = self.storage.get_bots()[0]['id']
        self.config = dict(communications_enabled=True, twilio_account_sid='AC' + 'a' * 32, twilio_auth_token='test-twilio-secret', owner_phone_number='+34612345678', twilio_voice_number='+12025550123', twilio_whatsapp_number='+14155238886', communication_bot_id=self.bot_id, communication_public_url='https://dots.example')
        self.service.save_config(CommunicationSettings(**self.config))
        self.post = AsyncMock(return_value={'sid': 'CA' + 'b'*32, 'status': 'queued'})
        self.captured = []
        async def provider(**kwargs):
            self.captured.append(kwargs)
            yield {'type': 'content.delta', 'delta': 'Respuesta real de prueba.'}
            yield {'type': 'turn.completed', 'ok': True}
        self.patches = [patch('app.routers.communications.communication_service', self.service), patch.object(self.service, '_post', self.post), patch('app.services.communication_service.provider_service.stream_chat_completion', provider), patch('app.services.communication_service.memory_service.context', return_value='')]
        for item in self.patches: item.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1')
        self.auth = {'Authorization': 'Bearer ' + auth_service.token}

    async def asyncTearDown(self):
        await self.client.aclose()
        for item in reversed(self.patches): item.stop()
        self.directory.cleanup()

    def form(self, channel='whatsapp', **extra):
        return {'AccountSid': self.config['twilio_account_sid'], 'From': 'whatsapp:' + self.config['owner_phone_number'] if channel == 'whatsapp' else self.config['twilio_voice_number'], 'To': 'whatsapp:' + self.config['twilio_whatsapp_number'] if channel == 'whatsapp' else self.config['owner_phone_number'], **extra}

    async def webhook(self, path, form, *, signed=True, headers=None):
        data = self.config['communication_public_url'] + path
        for key in sorted(form): data += key + form[key]
        signature = base64.b64encode(hmac.new(self.config['twilio_auth_token'].encode(), data.encode(), hashlib.sha1).digest()).decode()
        return await self.client.post(path, content=urlencode(form), headers={'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature if signed else 'bad', **(headers or {})})

    async def test_settings_and_send_require_owner_login(self):
        for path in ['/settings', '/events']:
            self.assertEqual((await self.client.get('/api/v1/communications' + path)).status_code, 401)
        self.assertEqual((await self.client.post('/api/v1/communications/call', json={'bot_id': self.bot_id, 'message': 'Hola'})).status_code, 401)
        self.assertEqual(self.post.await_count, 0)

    async def test_token_is_encrypted_and_never_returned(self):
        response = await self.client.get('/api/v1/communications/settings', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(self.config['twilio_auth_token'], response.text)
        self.assertTrue(response.json()['twilio_auth_token_configured'])
        self.assertEqual(response.json()['twilio_auth_token'], '')
        with self.storage.database.connect() as db:
            row = db.execute("SELECT value,is_secret FROM settings WHERE key='twilio_auth_token'").fetchone()
        self.assertEqual(row['is_secret'], 1)
        self.assertNotIn(self.config['twilio_auth_token'], row['value'])
        reopened = CommunicationService(StorageService(Path(self.directory.name)))
        self.assertEqual(reopened.config()['twilio_auth_token'], self.config['twilio_auth_token'])
        self.service.save_config(CommunicationSettings(twilio_auth_token=''))
        self.assertEqual(self.service.config()['twilio_auth_token'], self.config['twilio_auth_token'])

    async def test_invalid_numbers_and_public_url_rejected(self):
        for change in [{'owner_phone_number': '612345678'}, {'communication_public_url': 'http://dots.example'}, {'communication_public_url': 'https://user:secret@dots.example'}, {'twilio_account_sid': 'wrong'}]:
            response = await self.client.post('/api/v1/communications/settings', json=change, headers=self.auth)
            self.assertEqual(response.status_code, 422)

    async def test_disabled_connection_rejects_calls_and_webhooks(self):
        self.service.save_config(CommunicationSettings(communications_enabled=False))
        response = await self.client.post('/api/v1/communications/call', headers=self.auth, json={'bot_id': self.bot_id, 'message': 'Hola'})
        self.assertEqual(response.status_code, 409)
        response = await self.webhook('/api/v1/communications/webhooks/whatsapp', self.form(MessageSid='SM'+'c'*32, Body='Hola'))
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.post.await_count, 0)

    async def test_call_and_message_only_target_owner_number(self):
        call = await self.client.post('/api/v1/communications/call', headers=self.auth, json={'bot_id': self.bot_id, 'message': 'Hola'})
        self.assertEqual(call.status_code, 200)
        self.assertEqual(self.post.call_args.args[1]['To'], self.config['owner_phone_number'])
        self.assertEqual(self.post.call_args.args[1]['TimeLimit'], '180')
        self.assertTrue(self.post.call_args.args[1]['Url'].startswith('https://dots.example/api/v1/communications/webhooks/voice?session='))
        wa = await self.client.post('/api/v1/communications/whatsapp', headers=self.auth, json={'bot_id': self.bot_id, 'message': 'Mi resumen', 'to': '+34999999999'})
        self.assertEqual(wa.status_code, 422)
        wa = await self.client.post('/api/v1/communications/whatsapp', headers=self.auth, json={'bot_id': self.bot_id, 'message': 'Mi resumen'})
        self.assertEqual(wa.status_code, 200)
        self.assertEqual(self.post.call_args.args[1]['To'], 'whatsapp:' + self.config['owner_phone_number'])
        self.assertEqual(self.service.recent()[0]['status'], 'submitted')

    async def test_unsigned_or_other_sender_never_reaches_model(self):
        path = '/api/v1/communications/webhooks/whatsapp'
        form = self.form(MessageSid='SM'+'c'*32, Body='Hola')
        self.assertEqual((await self.webhook(path, form, signed=False)).status_code, 403)
        self.assertEqual((await self.webhook(path, {**form, 'From': 'whatsapp:+34999999999'})).status_code, 403)
        self.assertEqual((await self.webhook(path, {**form, 'To': 'whatsapp:+34999999999'})).status_code, 403)
        self.assertEqual((await self.webhook(path, {**form, 'AccountSid': 'AC'+'d'*32})).status_code, 403)
        self.assertEqual(self.captured, [])
        self.assertEqual(self.post.await_count, 0)

    async def test_signed_inbound_reply_is_deduplicated_and_has_no_tools(self):
        path = '/api/v1/communications/webhooks/whatsapp'
        form = self.form(MessageSid='SM'+'c'*32, Body='Hola')
        for _ in range(2):
            self.assertEqual((await self.webhook(path, form)).status_code, 200)
        self.assertEqual(len(self.captured), 1)
        self.assertNotIn('tools', self.captured[0])
        self.assertEqual(self.post.await_count, 1)
        self.assertEqual(self.post.call_args.args[1]['Body'], 'Respuesta real de prueba.')
        reopened = CommunicationService(StorageService(Path(self.directory.name)))
        self.assertFalse(reopened.claim(form['MessageSid'], 'whatsapp_in', {'message': 'Hola'}))

    async def test_voice_gathers_speech_and_returns_escaped_model_answer(self):
        result = await self.service.send('voice', CommunicationMessage(bot_id=self.bot_id, message='Resumen <script>'))
        form = self.form('voice', CallSid='CA'+'b'*32)
        path = self.service.url(result['id']).removeprefix(self.config['communication_public_url'])
        response = await self.webhook(path, form)
        self.assertEqual(response.status_code, 200)
        self.assertIn('Gather', response.text)
        self.assertIn('Resumen &lt;script&gt;', response.text)
        path = self.service.url(result['id'], 'listen', 1).removeprefix(self.config['communication_public_url'])
        for _ in range(2):
            response = await self.webhook(path, {**form, 'SpeechResult': 'Qué planes tengo'})
            self.assertEqual(response.status_code, 200)
        self.assertEqual(len(self.captured), 1)
        self.assertNotIn('tools', self.captured[0])
        path = self.service.url(result['id'], 'poll', 1).removeprefix(self.config['communication_public_url'])
        self.assertIn('Respuesta real de prueba.', (await self.webhook(path, form)).text)
        self.assertEqual((await self.webhook(path, {**form, 'CallSid': 'CA'+'e'*32})).status_code, 403)

    async def test_daily_outbound_limit_persists_across_restart(self):
        for _ in range(10):
            await self.service.send('whatsapp', CommunicationMessage(bot_id=self.bot_id, message='Resumen'))
        reopened = CommunicationService(StorageService(Path(self.directory.name)))
        with self.assertRaises(CommunicationError):
            await reopened.send('whatsapp', CommunicationMessage(bot_id=self.bot_id, message='Otro'))
        self.assertEqual(self.post.await_count, 10)

    async def test_twilio_failure_is_recorded_and_not_claimed_as_delivered(self):
        self.post.side_effect = CommunicationError('Proveedor sin saldo.')
        response = await self.client.post('/api/v1/communications/call', headers=self.auth, json={'bot_id': self.bot_id, 'message': 'Hola'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.service.recent()[0]['status'], 'failed')

    async def test_agent_communication_actions_cannot_send_before_approval_or_after_denial(self):
        with patch('app.services.communication_actions.communication_service', self.service), patch('app.services.approval_broker.storage_service', self.storage):
            for tool_name, channel in [('call_owner', 'voice'), ('whatsapp_owner', 'whatsapp')]:
                broker = ApprovalBroker()
                gateway = ActionGateway(approvals=broker, audit=self.storage)
                gateway.register_action(action_gateway.definitions['communication.' + channel], execute)
                invocation = communication_invocation(tool_name, self.bot_id, 'Mensaje revisado')
                request, approval = gateway.open(self.bot_id, self.bot_id, invocation)
                self.assertIn(self.config['owner_phone_number'], approval['summary'])
                count = self.post.await_count
                with self.assertRaises(ActionGatewayError):
                    await gateway.execute(request)
                self.assertEqual(self.post.await_count, count)
                broker.resolve(request.request_id, 'deny')
                self.assertEqual(await gateway.wait_for_decision(request), 'deny')
                with self.assertRaises(ActionGatewayError):
                    await gateway.execute(request)
                self.assertEqual(self.post.await_count, count)
                request, _ = gateway.open(self.bot_id, self.bot_id, invocation)
                broker.resolve(request.request_id, 'allow')
                await gateway.wait_for_decision(request)
                result = await gateway.execute(request)
                self.assertEqual(result.status, 'completed')
                self.assertEqual(self.post.await_count, count + 1)
                with self.assertRaises(ActionGatewayError):
                    await gateway.execute(request)
                self.assertEqual(self.post.await_count, count + 1)

    async def test_automatic_whatsapp_does_not_auto_authorize_calls_and_sends_only_to_owner(self):
        self.storage.save_settings({'whatsapp_send_mode': 'automatic'})
        broker = ApprovalBroker()
        gateway = ActionGateway(approvals=broker, audit=self.storage)
        with patch('app.services.communication_actions.communication_service', self.service), patch('app.services.approval_broker.storage_service', self.storage):
            for channel in ('voice', 'whatsapp'):
                gateway.register_action(action_gateway.definitions['communication.' + channel], execute)
            call, call_review = gateway.open(self.bot_id, self.bot_id, communication_invocation('call_owner', self.bot_id, 'Llamada'))
            self.assertIsNotNone(call_review)
            self.assertTrue(call.requires_approval)
            gateway.cancel_pending(call)
            request, review = gateway.open(self.bot_id, self.bot_id, communication_invocation('whatsapp_owner', self.bot_id, '2+2=4'))
            self.assertIsNone(review)
            self.assertFalse(request.requires_approval)
            self.assertEqual(await gateway.wait_for_decision(request), 'allow')
            result = await gateway.execute(request)
        self.assertEqual(result.status, 'completed')
        self.assertEqual(self.post.await_count, 1)
        self.assertEqual(self.post.call_args.args[1]['To'], 'whatsapp:' + self.config['owner_phone_number'])

    async def test_changed_twilio_account_or_owner_snapshot_blocks_dispatch_even_in_automatic_mode(self):
        self.storage.save_settings({'whatsapp_send_mode': 'automatic'})
        with patch('app.services.communication_actions.communication_service', self.service):
            invocation = communication_invocation('whatsapp_owner', self.bot_id, '2+2=4')
            self.storage.save_settings({'owner_phone_number': '+34611111111'})
            with self.assertRaisesRegex(CommunicationError, 'han cambiado'):
                await execute(invocation)
        self.post.assert_not_awaited()

    async def test_phone_tools_are_hidden_when_disabled_and_never_run_in_background(self):
        with patch('app.services.agent_service.communication_service', self.service), patch('app.services.agent_service.storage_service', self.storage):
            for background in [False, True]:
                _ = [event async for event in run_agent(self.bot_id, 'test-model', [], '', background=background)]
                names = {tool['function']['name'] for tool in self.captured[-1]['tools']}
                self.assertEqual('call_owner' in names, not background)
                self.assertEqual('whatsapp_owner' in names, not background)
            self.service.save_config(CommunicationSettings(communications_enabled=False))
            _ = [event async for event in run_agent(self.bot_id, 'test-model', [], '')]
            names = {tool['function']['name'] for tool in self.captured[-1]['tools']}
            self.assertNotIn('call_owner', names)
            self.assertNotIn('whatsapp_owner', names)

    async def test_twilio_rest_adapter_uses_basic_auth_and_sanitizes_provider_errors(self):
        self.patches[1].stop()
        captured = []
        def handler(request):
            captured.append(request)
            return httpx.Response(201, json={'sid': 'CA' + 'b'*32, 'status': 'queued'})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch('app.services.communication_service.httpx.AsyncClient', return_value=client):
            result = await self.service._post('Calls', {'To': self.config['owner_phone_number'], 'From': self.config['twilio_voice_number']})
        self.assertEqual(result['status'], 'queued')
        self.assertEqual(str(captured[0].url), 'https://api.twilio.com/2010-04-01/Accounts/' + self.config['twilio_account_sid'] + '/Calls.json')
        expected = base64.b64encode((self.config['twilio_account_sid'] + ':' + self.config['twilio_auth_token']).encode()).decode()
        self.assertEqual(captured[0].headers['Authorization'], 'Basic ' + expected)
        for code in [20003, 63016]:
            client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(401, json={'code': code, 'message': self.config['twilio_auth_token']})))
            with patch('app.services.communication_service.httpx.AsyncClient', return_value=client):
                with self.assertRaises(CommunicationError) as raised:
                    await self.service._post('Messages', {'Body': 'Hola'})
            self.assertNotIn(self.config['twilio_auth_token'], str(raised.exception))
            if code == 63016:
                self.assertIn('24 horas', str(raised.exception))

    async def test_render_origin_survives_blank_saved_url_and_defaults_to_first_bot(self):
        self.service.save_config(CommunicationSettings(communication_public_url='', communication_bot_id=''))
        with patch.dict(os.environ, {'RENDER_EXTERNAL_URL': ' https://dots-render.example/ ', 'PUBLIC_APP_URL': '', 'COMMUNICATION_PUBLIC_URL': ''}):
            config = self.service.public_config()
        self.assertEqual(config['communication_public_url'], 'https://dots-render.example')
        self.assertEqual(config['communication_bot_id'], self.bot_id)
        self.assertTrue(config['voice_ready'])
        self.assertTrue(config['whatsapp_ready'])

    async def test_app_link_is_normalized_and_token_whitespace_is_removed(self):
        data = CommunicationSettings(communication_public_url='https://dots.example/app/', twilio_auth_token='  replacement-secret  ')
        self.service.save_config(data)
        self.assertEqual(self.service.config()['communication_public_url'], 'https://dots.example')
        self.assertEqual(self.service.config()['twilio_auth_token'], 'replacement-secret')

    async def test_bad_stored_configuration_can_be_loaded_and_repaired(self):
        self.storage.save_settings({'twilio_voice_number': 'invalid'})
        response = await self.client.get('/api/v1/communications/settings', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertFalse(data['voice_ready'])
        self.assertTrue(data['whatsapp_ready'])
        self.assertIn('formato internacional', ' '.join(data['setup_issues']['voice']))
        self.assertNotIn(self.config['twilio_auth_token'], response.text)
        response = await self.client.post('/api/v1/communications/settings', headers=self.auth, json={'twilio_voice_number': self.config['twilio_voice_number']})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['voice_ready'])

    async def test_nvidia_key_in_twilio_field_is_hidden_and_reported_as_invalid(self):
        wrong_token = 'nvapi-' + 'fixture' * 5
        self.storage.save_settings({'twilio_auth_token': wrong_token})
        response = await self.client.get('/api/v1/communications/settings', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(wrong_token, response.text)
        self.assertFalse(response.json()['twilio_auth_token_configured'])
        self.assertFalse(response.json()['voice_ready'])
        self.assertIn('no la clave de NVIDIA', ' '.join(response.json()['setup_issues']['voice']))

    async def test_diagnostic_verifies_trial_account_without_external_effects(self):
        requests = []
        original_client = httpx.AsyncClient
        def handler(request):
            requests.append(request)
            self.assertEqual(request.method, 'GET')
            if request.url.path == '/api/v1/health':
                return httpx.Response(200, json={'status': 'online'})
            if request.url.path.endswith('/IncomingPhoneNumbers.json'):
                self.assertEqual(request.url.params['PhoneNumber'], self.config['twilio_voice_number'])
                return httpx.Response(200, json={'incoming_phone_numbers': [{'phone_number': self.config['twilio_voice_number'], 'capabilities': {'voice': True}}]})
            if request.url.path.endswith('/OutgoingCallerIds.json'):
                return httpx.Response(200, json={'outgoing_caller_ids': [{'phone_number': self.config['owner_phone_number']}]})
            return httpx.Response(200, json={'status': 'active', 'type': 'Trial'})
        def client_factory(*args, **kwargs):
            return original_client(transport=httpx.MockTransport(handler))
        with patch('app.services.communication_service.httpx.AsyncClient', side_effect=client_factory):
            response = await self.client.post('/api/v1/communications/check', headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()['ok'])
        self.assertEqual(len(requests), 4)
        self.assertEqual(self.post.await_count, 0)
        self.assertEqual(self.service.recent(), [])
        self.assertNotIn(self.config['twilio_auth_token'], response.text)
        self.assertEqual((await self.client.post('/api/v1/communications/check')).status_code, 401)

    async def test_diagnostic_reports_authentication_failure_without_leaking_token(self):
        original_client = httpx.AsyncClient
        def handler(request):
            if request.url.path == '/api/v1/health':
                return httpx.Response(200, json={'status': 'online'})
            return httpx.Response(401, json={'code': 20003, 'message': self.config['twilio_auth_token']})
        with patch('app.services.communication_service.httpx.AsyncClient', side_effect=lambda *a, **kw: original_client(transport=httpx.MockTransport(handler))):
            response = await self.client.post('/api/v1/communications/check', headers=self.auth)
        self.assertFalse(response.json()['ok'])
        self.assertIn('20003', response.text)
        self.assertNotIn(self.config['twilio_auth_token'], response.text)
        self.assertEqual(self.post.await_count, 0)

    async def test_diagnostic_finds_unverified_trial_destination_and_wrong_voice_sender(self):
        original_client = httpx.AsyncClient
        def handler(request):
            if request.url.path == '/api/v1/health':
                return httpx.Response(200, json={'status': 'online'})
            if request.url.path.endswith('/IncomingPhoneNumbers.json'):
                return httpx.Response(200, json={'incoming_phone_numbers': []})
            if request.url.path.endswith('/OutgoingCallerIds.json'):
                return httpx.Response(200, json={'outgoing_caller_ids': []})
            return httpx.Response(200, json={'status': 'active', 'type': 'Trial'})
        with patch('app.services.communication_service.httpx.AsyncClient', side_effect=lambda *a, **kw: original_client(transport=httpx.MockTransport(handler))):
            report = await self.service.check_connection()
        by_id = {check['id']: check for check in report['checks']}
        self.assertFalse(by_id['voice_number']['ok'])
        self.assertFalse(by_id['trial_phone']['ok'])
        self.assertEqual(self.post.await_count, 0)

    async def test_call_callbacks_report_progress_and_do_not_regress(self):
        result = await self.service.send('voice', CommunicationMessage(bot_id=self.bot_id, message='Hola'))
        path = self.post.call_args.args[1]['StatusCallback'].removeprefix(self.config['communication_public_url'])
        self.assertEqual(self.post.call_args.args[1]['StatusCallbackEvent'], ['initiated', 'ringing', 'answered', 'completed'])
        form = self.form('voice', CallSid=result['sid'])
        for status in ['ringing', 'in-progress']:
            response = await self.webhook(path, {**form, 'CallStatus': status})
            self.assertEqual(response.status_code, 204)
            self.assertEqual(self.service.recent()[0]['status'], status)
            voice_path = self.service.url(result['id']).removeprefix(self.config['communication_public_url'])
            self.assertEqual((await self.webhook(voice_path, form)).status_code, 200)
        for status in ['completed', 'ringing', 'completed']:
            self.assertEqual((await self.webhook(path, {**form, 'CallStatus': status})).status_code, 204)
        self.assertEqual(self.service.recent()[0]['status'], 'completed')

    async def test_whatsapp_delivery_failure_keeps_sandbox_error_in_history(self):
        self.post.return_value = {'sid': 'SM' + 'b'*32, 'status': 'queued'}
        result = await self.service.send('whatsapp', CommunicationMessage(bot_id=self.bot_id, message='Hola'))
        path = self.post.call_args.args[1]['StatusCallback'].removeprefix(self.config['communication_public_url'])
        form = self.form(MessageSid=result['sid'], From='whatsapp:' + self.config['twilio_whatsapp_number'], To='whatsapp:' + self.config['owner_phone_number'], MessageStatus='failed', ErrorCode='63015')
        self.assertEqual((await self.webhook(path, form)).status_code, 204)
        event = self.service.recent()[0]
        self.assertEqual(event['status'], 'failed')
        self.assertEqual(event['error_code'], 63015)
        self.assertIn('join', event['error'])
        self.assertEqual((await self.webhook(path, {**form, 'MessageStatus': 'sent', 'ErrorCode': ''})).status_code, 204)
        self.assertEqual(self.service.recent()[0]['status'], 'failed')

    async def test_status_callback_requires_signature_account_and_matching_sid(self):
        result = await self.service.send('voice', CommunicationMessage(bot_id=self.bot_id, message='Hola'))
        path = self.post.call_args.args[1]['StatusCallback'].removeprefix(self.config['communication_public_url'])
        form = self.form('voice', CallSid=result['sid'], CallStatus='completed')
        self.assertEqual((await self.webhook(path, form, signed=False)).status_code, 403)
        self.assertEqual((await self.webhook(path, {**form, 'CallSid': 'CA'+'e'*32})).status_code, 403)
        self.assertEqual((await self.webhook(path, {**form, 'AccountSid': 'AC'+'d'*32})).status_code, 403)
        self.assertEqual((await self.webhook(path, {**form, 'To': '+34999999999'})).status_code, 403)
        self.assertEqual(self.service.recent()[0]['status'], 'submitted')

    async def test_inbound_whatsapp_reply_tracks_delivery_and_read_without_regressing(self):
        self.post.return_value = {'sid': 'SM' + 'b'*32, 'status': 'queued'}
        response = await self.webhook('/api/v1/communications/webhooks/whatsapp', self.form(MessageSid='SM'+'c'*32, Body='Hola'))
        self.assertEqual(response.status_code, 200)
        path = self.post.call_args.args[1]['StatusCallback'].removeprefix(self.config['communication_public_url'])
        form = self.form(MessageSid='SM'+'b'*32, From='whatsapp:' + self.config['twilio_whatsapp_number'], To='whatsapp:' + self.config['owner_phone_number'])
        for status in ['sent', 'delivered', 'read', 'sent']:
            self.assertEqual((await self.webhook(path, {**form, 'MessageStatus': status})).status_code, 204)
        event = self.service.recent()[0]
        self.assertEqual(event['status'], 'read')
        self.assertEqual(event['channel'], 'whatsapp_in')
        self.assertEqual(event['reply'], 'Respuesta real de prueba.')

    async def test_early_voice_webhook_is_accepted_and_rest_response_does_not_reset_it(self):
        async def post(resource, data):
            path = data['Url'].removeprefix(self.config['communication_public_url'])
            response = await self.webhook(path, self.form('voice', CallSid='CA'+'b'*32))
            self.assertEqual(response.status_code, 200)
            self.assertIn('Gather', response.text)
            return {'sid': 'CA'+'b'*32, 'status': 'queued'}
        self.post.side_effect = post
        result = await self.service.send('voice', CommunicationMessage(bot_id=self.bot_id, message='Hola'))
        self.assertEqual(self.service.record(result['id'])['status'], 'in-progress')

    async def test_early_status_callback_survives_rest_response_and_disabled_connection(self):
        async def post(resource, data):
            path = data['StatusCallback'].removeprefix(self.config['communication_public_url'])
            response = await self.webhook(path, self.form('voice', CallSid='CA'+'b'*32, CallStatus='ringing'))
            self.assertEqual(response.status_code, 204)
            return {'sid': 'CA'+'b'*32, 'status': 'queued'}
        self.post.side_effect = post
        result = await self.service.send('voice', CommunicationMessage(bot_id=self.bot_id, message='Hola'))
        self.assertEqual(self.service.record(result['id'])['status'], 'ringing')
        self.service.save_config(CommunicationSettings(communications_enabled=False))
        path = self.service.status_url(result['id'], 'voice').removeprefix(self.config['communication_public_url'])
        response = await self.webhook(path, self.form('voice', CallSid=result['sid'], CallStatus='completed'))
        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.service.record(result['id'])['status'], 'completed')

    async def test_rest_failure_is_saved_with_specific_error_code(self):
        self.post.side_effect = CommunicationError('Twilio 21219: verifica tu teléfono.', 21219)
        response = await self.client.post('/api/v1/communications/call', headers=self.auth, json={'bot_id': self.bot_id, 'message': 'Hola'})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.service.recent()[0]['error_code'], 21219)
        self.assertIn('21219', self.service.recent()[0]['error'])
