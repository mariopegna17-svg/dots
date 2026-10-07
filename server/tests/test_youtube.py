import asyncio
import base64
import io
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from starlette.datastructures import Headers, UploadFile
from pydantic import ValidationError

from app.main import app
from app.routers import connectors
from app.schemas.youtube import YouTubeConfirmation, YouTubeMetadata
from app.services.auth_service import auth_service
from app.services.connector_service import ConnectorService
from app.services.composio_service import ConnectorServiceError
from app.services.storage_service import StorageService
from app.services.youtube_service import CHUNK_BYTES, YouTubeService
from app.services.youtube_actions import youtube_invocation
from app.services.action_gateway import ActionGateway


class FakeConnections:
    def __init__(self):
        self.account = 'ca_owner_youtube'
        self.secret = 'fixture-composio-secret'
        self.calls = []
        self.location = 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture-session'
        self.fail_final = False

    def key(self):
        return self.secret

    async def accounts(self, slugs):
        return [{'id': self.account, 'status': 'ACTIVE', 'toolkit': {'slug': 'youtube'}}]

    async def proxy(self, account, endpoint, method='GET', **kwargs):
        self.calls.append((account, endpoint, method, kwargs))
        if '/channels?' in endpoint:
            return {'status': 200, 'data': {'items': [{'id': 'UC_fixture', 'snippet': {'title': 'Mi canal'}}]}}
        if method == 'POST':
            return {'status': 200, 'headers': {'Location': self.location}}
        content = base64.b64decode(kwargs['binary_body']['base64'])
        header = kwargs['parameters'][0]['value']
        span, total = header.removeprefix('bytes ').split('/')
        begin, end = map(int, span.split('-'))
        assert len(content) == end - begin + 1
        if end + 1 < int(total):
            return {'status': 308, 'headers': {'Range': f'bytes=0-{end}'}}
        if self.fail_final:
            return {'status': 403, 'data': {'error': {'message': self.secret, 'errors': [{'reason': 'quotaExceeded'}]}}}
        return {'status': 201, 'data': {'id': 'abcDEF123_-', 'status': {'privacyStatus': 'private'}}}


def video(content=b'fixture-video'):
    return UploadFile(io.BytesIO(content), size=len(content), filename='video.mp4', headers=Headers({'content-type': 'video/mp4'}))


class YouTubeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.connections = FakeConnections()
        self.service = YouTubeService(self.storage, self.connections)
        self.metadata = YouTubeMetadata(title='Mi vídeo', made_for_kids=False)
        self.patches = [patch.object(connectors, 'youtube_service', self.service)]
        for p in self.patches: p.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1')
        self.auth = {'Authorization': 'Bearer ' + auth_service.token}

    async def asyncTearDown(self):
        await self.service.stop()
        await self.client.aclose()
        for p in reversed(self.patches): p.stop()
        self.directory.cleanup()

    async def finish(self):
        await asyncio.gather(*list(self.service.workers))

    async def test_prepare_does_not_publish_and_keeps_private_file(self):
        item = await self.service.prepare(video(), self.metadata)
        self.assertEqual(item['status'], 'ready')
        self.assertEqual(item['privacy'], 'private')
        self.assertFalse(any(c[2] != 'GET' for c in self.connections.calls))
        self.assertNotIn('account_id', item)
        self.assertNotIn('key_fingerprint', item)
        self.assertEqual(self.service.path(item).stat().st_mode & 0o777, 0o600)

    async def test_resumable_upload_uses_exact_bytes_channel_and_metadata_once(self):
        content = b'a' * (CHUNK_BYTES + 25)
        item = await self.service.prepare(video(content), YouTubeMetadata(title='Público solicitado', description='Descripción', privacy='public', made_for_kids=True))
        await self.service.publish(item['id'])
        with self.assertRaises(ConnectorServiceError): await self.service.publish(item['id'])
        await self.finish()
        result = self.service.get(item['id'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(result['uploaded_bytes'], len(content))
        self.assertEqual(result['actual_privacy'], 'private')
        self.assertEqual(result['url'], 'https://www.youtube.com/watch?v=abcDEF123_-')
        posts = [c for c in self.connections.calls if c[2] == 'POST']
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][3]['body']['status'], {'privacyStatus': 'public', 'selfDeclaredMadeForKids': True})
        puts = [c for c in self.connections.calls if c[2] == 'PUT']
        self.assertEqual(b''.join(base64.b64decode(c[3]['binary_body']['base64']) for c in puts), content)
        self.assertTrue(all(c[0] == self.connections.account for c in puts))
        self.assertFalse(self.service.path(item).exists())
        with self.assertRaises(ConnectorServiceError): await self.service.publish(item['id'])

    async def test_invalid_upload_host_is_rejected_before_transmitting_video(self):
        for location in ['http://127.0.0.1/upload/youtube/v3/videos', 'https://evil.example/upload/youtube/v3/videos', 'https://www.googleapis.com/other', 'https://www.googleapis.com:8080/upload/youtube/v3/videos']:
            self.connections.location = location
            item = await self.service.prepare(video(), self.metadata)
            self.connections.calls.clear()
            await self.service.publish(item['id']); await self.finish()
            self.assertEqual(self.service.get(item['id'])['status'], 'failed')
            self.assertFalse(any(c[2] == 'PUT' for c in self.connections.calls))

    async def test_changed_channel_or_key_requires_new_review(self):
        for change in ('account', 'secret'):
            item = await self.service.prepare(video(), self.metadata)
            setattr(self.connections, change, getattr(self.connections, change) + '_changed')
            with self.assertRaises(ConnectorServiceError): await self.service.publish(item['id'])
            self.assertEqual(self.service.get(item['id'])['status'], 'ready')
            self.service.discard(item['id'])

    async def test_limits_empty_file_and_expired_draft_delete_temporary_files(self):
        with self.assertRaises(ConnectorServiceError): await self.service.prepare(video(b''), self.metadata)
        with patch('app.services.youtube_service.MAX_VIDEO_BYTES', 10):
            with self.assertRaises(ConnectorServiceError): await self.service.prepare(video(b'a'*11), self.metadata)
        item = await self.service.prepare(video(), self.metadata)
        private = self.service.get(item['id']); private['expires_at'] = time.time() - 1; self.service.save(private)
        self.service.cleanup()
        self.assertEqual(self.service.get(item['id'])['status'], 'expired')
        self.assertFalse(self.service.path(item).exists())
        with self.assertRaises(ConnectorServiceError): await self.service.publish(item['id'])

    async def test_provider_quota_error_is_actionable_and_hides_secrets(self):
        self.connections.fail_final = True
        item = await self.service.prepare(video(), self.metadata)
        await self.service.publish(item['id']); await self.finish()
        result = self.service.get(item['id'])
        self.assertEqual(result['status'], 'failed')
        self.assertIn('cuota', result['error'])
        self.assertNotIn(self.connections.secret, json.dumps(result))
        self.assertEqual(result['url'], '')

    async def test_restart_does_not_repeat_an_interrupted_upload(self):
        item = await self.service.prepare(video(), self.metadata)
        private = self.service.get(item['id']); private['status'] = 'uploading'; self.service.save(private)
        self.connections.calls.clear()
        reopened = YouTubeService(self.storage, self.connections)
        await reopened.start(); await reopened.stop()
        self.assertEqual(reopened.get(item['id'])['status'], 'interrupted')
        self.assertFalse(reopened.path(item).exists())
        self.assertEqual(self.connections.calls, [])

    async def test_anonymous_routes_and_missing_confirmation_cannot_publish(self):
        for route in ['/catalog', '/youtube/channel', '/youtube/uploads']:
            self.assertEqual((await self.client.get('/api/v1/connectors' + route)).status_code, 401)
        item = await self.service.prepare(video(), self.metadata)
        path = '/api/v1/connectors/youtube/uploads/' + item['id'] + '/publish'
        self.assertEqual((await self.client.post(path, json={'confirmed': True})).status_code, 401)
        for body in ({}, {'confirmed': False}):
            self.assertEqual((await self.client.post(path, json=body, headers=self.auth)).status_code, 422)
        self.assertEqual(self.service.get(item['id'])['status'], 'ready')
        self.assertFalse(any(c[2] != 'GET' for c in self.connections.calls))

    async def test_http_prepare_validation_and_owner_scoping(self):
        path = '/api/v1/connectors/youtube/uploads'
        response = await self.client.post(path, headers=self.auth, files={'file': ('video.mp4', b'video', 'video/mp4')}, data={'metadata': self.metadata.model_dump_json()})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'ready')
        bad = await self.client.post(path, headers=self.auth, files={'file': ('video.mp4', b'video', 'video/mp4')}, data={'metadata': '{"title":"hola"}'})
        self.assertEqual(bad.status_code, 422)
        with self.storage.database.connect() as db:
            db.execute("UPDATE tasks SET owner_id = 'another-owner' WHERE id = ?", (response.json()['id'],))
        with self.assertRaises(ConnectorServiceError): self.service.get(response.json()['id'])

    async def test_agent_upload_proposal_requires_specific_approval(self):
        item = await self.service.prepare(video(), self.metadata)
        with patch('app.services.youtube_actions.youtube_service', self.service):
            invocation = youtube_invocation(item['id'])
        gateway = ActionGateway(audit=self.storage)
        # Use the real registered definition but no executor is needed to open a proposal.
        from app.services.youtube_actions import action_gateway
        gateway.register_action(action_gateway.definitions['youtube.publish'], AsyncMock())
        request, approval = gateway.open('thread-fixture', 'bot-fixture', invocation)
        self.assertTrue(request.requires_approval)
        self.assertEqual(request.risk, 'external')
        self.assertIn('Mi canal', request.preview)
        self.assertEqual(approval['arguments']['privacy'], 'privado')
        self.assertFalse(any(c[2] != 'GET' for c in self.connections.calls))


class ConnectorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.storage.save_settings({'composio_api_key': 'fixture-key-secret'})
        self.service = ConnectorService(self.storage)

    async def asyncTearDown(self):
        self.directory.cleanup()

    async def test_account_filters_are_persistent_and_owner_scoped(self):
        owner = self.service.user_id()
        self.assertEqual(owner, ConnectorService(self.storage).user_id())
        self.service.request = AsyncMock(return_value={'items': [
            {'id': 'ca_own', 'user_id': owner, 'toolkit': {'slug': 'youtube'}, 'status': 'ACTIVE'},
            {'id': 'ca_foreign', 'user_id': 'someone-else', 'toolkit': {'slug': 'youtube'}, 'status': 'ACTIVE'},
            {'id': 'ca_other', 'toolkit': {'slug': 'github'}, 'status': 'ACTIVE'},
        ]})
        accounts = await self.service.accounts(['youtube'])
        self.assertEqual([a['id'] for a in accounts], ['ca_own'])
        self.assertEqual(self.service.request.call_args.kwargs['params']['user_ids'], [owner])

    async def test_youtube_oauth_uses_explicit_scopes_and_approved_host(self):
        self.service.request = AsyncMock(side_effect=[{'items': []}, {'auth_config': {'id': 'ac_fixture'}}, {'redirect_url': 'https://connect.composio.dev/link/fixture'}])
        result = await self.service.authorize('youtube')
        self.assertEqual(result['url'], 'https://connect.composio.dev/link/fixture')
        scopes = self.service.request.call_args_list[1].kwargs['json']['auth_config']['credentials']['scopes']
        self.assertIn('https://www.googleapis.com/auth/youtube.upload', scopes)
        self.assertEqual(self.service.request.call_args_list[2].kwargs['json']['user_id'], self.service.user_id())
        self.service.request = AsyncMock(side_effect=[{'items': []}, {'auth_config': {'id': 'ac_fixture'}}, {'redirect_url': 'https://evil.example/auth'}])
        with self.assertRaises(ConnectorServiceError): await self.service.authorize('youtube')

    async def test_multiple_toolkit_filters_use_openapi_array_serialization(self):
        async def handler(request):
            self.assertEqual(request.url.params.get_list('toolkit_slugs'), ['youtube', 'github'])
            self.assertEqual(request.url.params.get_list('user_ids'), [self.service.user_id()])
            return httpx.Response(200, json={'items': []})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch('app.services.connector_service.httpx.AsyncClient', return_value=client):
            self.assertEqual(await self.service.accounts(['youtube', 'github']), [])

    async def test_catalog_includes_youtube_and_recovers_on_provider_failure(self):
        with patch.object(connectors, 'connector_service', self.service), patch.object(connectors, '_catalog_cache', None):
            self.service.request = AsyncMock(return_value={'items': [{'slug': 'youtube', 'name': 'YouTube'}, {'slug': 'newapp', 'name': 'Nueva app'}]})
            result = await connectors.catalog()
            self.assertEqual(result['source'], 'api')
            self.assertEqual(sum(c['slug'] == 'youtube' for c in result['cards']), 1)
            self.assertTrue(any(c['slug'] == 'newapp' for c in result['cards']))
        with patch.object(connectors, 'connector_service', self.service), patch.object(connectors, '_catalog_cache', None):
            self.service.request = AsyncMock(side_effect=ConnectorServiceError('Fallo del proveedor'))
            result = await connectors.catalog()
            self.assertTrue(result['configured'])
            self.assertIn('warning', result)

    async def test_youtube_can_use_the_owners_custom_google_oauth_config(self):
        self.service.request = AsyncMock(side_effect=[{'items': [{'id': 'ac_custom', 'name': 'Mi Google OAuth', 'is_composio_managed': False}]}, {'redirect_url': 'https://connect.composio.dev/link/custom'}])
        await self.service.authorize('youtube')
        self.assertEqual(self.service.request.call_args.kwargs['json']['auth_config_id'], 'ac_custom')
        self.assertEqual(self.service.request.await_count, 2)

    async def test_provider_http_error_does_not_echo_credentials(self):
        async def handler(request):
            self.assertEqual(request.headers['x-api-key'], 'fixture-key-secret')
            return httpx.Response(401, json={'error': 'fixture-key-secret must never be echoed'})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch('app.services.connector_service.httpx.AsyncClient', return_value=client):
            with self.assertRaises(ConnectorServiceError) as caught:
                await self.service.request('GET', '/toolkits')
        self.assertNotIn('fixture-key-secret', str(caught.exception))

    async def test_proxy_transmits_the_documented_binary_body_without_exposing_a_token(self):
        async def handler(request):
            self.assertEqual(request.url.path, '/api/v3/tools/execute/proxy')
            data = json.loads(request.content)
            self.assertEqual(data['binary_body']['base64'], base64.b64encode(b'video-chunk').decode())
            self.assertEqual(data['connected_account_id'], 'ca_fixture')
            self.assertNotIn('Authorization', json.dumps(data))
            return httpx.Response(200, json={'status': 308, 'headers': {'range': 'bytes=0-10'}})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch('app.services.connector_service.httpx.AsyncClient', return_value=client):
            result = await self.service.proxy('ca_fixture', 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture', 'PUT', binary_body={'base64': base64.b64encode(b'video-chunk').decode(), 'content_type': 'video/mp4'})
        self.assertEqual(result['status'], 308)

    async def test_setup_validates_then_encrypts_without_echoing_key(self):
        self.service.request = AsyncMock(return_value={'items': []})
        with patch.object(connectors, 'connector_service', self.service), patch.object(connectors, 'storage_service', self.storage):
            result = await connectors.setup(connectors.ConnectorSetup(api_key='new-fixture-secret'))
        self.assertTrue(result['configured'])
        self.assertNotIn('new-fixture-secret', json.dumps(result))
        self.assertNotIn(b'new-fixture-secret', self.storage.db_path.read_bytes())
        self.assertEqual(self.storage.get_settings()['composio_api_key'], 'new-fixture-secret')
        with self.assertRaises(ValidationError): connectors.ConnectorSetup(api_key='nvapi-wrong-provider')
