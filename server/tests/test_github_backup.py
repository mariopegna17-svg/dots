import asyncio
import base64
from datetime import datetime, timezone, timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import httpx

from app.main import app
from app.routers import persistence
from app.schemas.team import TeamInput
from app.services.connector_service import ConnectorService
from app.services.github_backup import GitHubBackup, BackupError, MAGIC
from app.services.memory_service import MemoryService
from app.services.routine_service import RoutineService
from app.services.storage_service import StorageService
from app.services.team_service import TeamService


class RemoteRepository:
    def __init__(self):
        self.branch = False
        self.payload = None
        self.sha = None
        self.calls = []
        self.fail = False

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        if self.fail:
            raise BackupError('GitHub no responde; la copia anterior se conserva.')
        if path == '':
            return {'default_branch': 'main'}
        if path == '/git/ref/heads/main':
            return {'object': {'sha': 'a' * 40}}
        if path == '/git/ref/heads/dots-data':
            return {'object': {'sha': 'b' * 40}} if self.branch else None
        if path == '/git/refs':
            assert kwargs['json']['ref'] == 'refs/heads/dots-data'
            self.branch = True
            return {'ref': 'refs/heads/dots-data'}
        if method == 'GET' and path == '/contents/dots-state.enc':
            if self.payload is None:
                return None
            return {'sha': self.sha, 'size': len(self.payload), 'encoding': 'base64', 'content': base64.b64encode(self.payload).decode()}
        if method == 'PUT' and path == '/contents/dots-state.enc':
            body = kwargs['json']
            if body.get('sha') != self.sha:
                raise BackupError('GitHub tiene otra versión; la copia existente se conserva.')
            assert body['branch'] == 'dots-data'
            self.payload = base64.b64decode(body['content'])
            self.sha = hashlib.sha1(self.payload).hexdigest()
            return {'content': {'sha': self.sha}}
        if path.startswith('/git/blobs/'):
            return self.payload
        raise AssertionError((method, path))


class GitHubBackupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / 'source'
        self.storage = StorageService(self.root)
        self.owner = 'fixture-owner-key-outside-github-1234567890'
        self.environment = {'GITHUB_BACKUP_TOKEN': 'fixture-private-github-token', 'GITHUB_BACKUP_REPOSITORY': 'fixture/dots', 'APP_AUTH_TOKEN': self.owner}
        self.remote = RemoteRepository()
        self.backup = self.service(self.root)
        self.storage.save_settings({'model_api_key': 'fixture-nvidia-private', 'composio_api_key': 'fixture-composio-private', 'twilio_auth_token': 'fixture-twilio-private', 'theme': 'aurora',
            'whatsapp_qr_enabled': True, 'whatsapp_qr_bot_id': self.storage.get_bots()[0]['id'], 'team_bot_ids': [b['id'] for b in self.storage.get_bots()[:2]], 'team_coordinator_id': self.storage.get_bots()[1]['id']})
        self.ids = [b['id'] for b in self.storage.get_bots()[:2]]
        MemoryService(self.storage).save(self.ids[0], 'Prefiero respuestas en español.')
        self.routine = RoutineService(self.storage).create(self.ids[0], 'Rutina guardada', 'Recordar mis notas', datetime.now(timezone.utc) + timedelta(days=3), 3600)
        self.team = TeamService(self.storage).create(TeamInput(prompt='Trabajo en equipo guardado', bot_ids=self.ids, coordinator_id=self.ids[1]))
        self.connector_id = ConnectorService(self.storage).user_id()
        (self.root / '.auth-token').write_text(self.owner)
        (self.root / 'workspace').mkdir()
        (self.root / 'workspace/notes.txt').write_text('Archivo de trabajo persistente')

    async def asyncTearDown(self):
        self.temp.cleanup()

    def service(self, root, env=None):
        service = GitHubBackup(root, env or self.environment)
        service.request = self.remote.request
        return service

    async def test_loss_of_entire_disk_recovers_keys_memory_routines_teams_and_identity(self):
        self.backup.bootstrap()
        self.backup.sync()
        original_ciphertext = self.remote.payload
        for secret in ('fixture-nvidia-private', 'fixture-composio-private', 'fixture-twilio-private', self.owner, 'fixture-private-github-token'):
            self.assertNotIn(secret.encode(), original_ciphertext)
        shutil.rmtree(self.root)
        restored = self.service(self.root)
        restored.bootstrap()
        storage = StorageService(self.root)
        self.assertEqual(storage.get_settings()['model_api_key'], 'fixture-nvidia-private')
        self.assertEqual(storage.get_settings()['composio_api_key'], 'fixture-composio-private')
        self.assertEqual(storage.get_settings()['theme'], 'aurora')
        self.assertEqual(storage.get_settings()['team_coordinator_id'], self.ids[1])
        self.assertTrue(storage.get_settings()['whatsapp_qr_enabled'])
        self.assertEqual(MemoryService(storage).list(self.ids[0])[0]['text'], 'Prefiero respuestas en español.')
        self.assertEqual(RoutineService(storage).list()[0]['id'], self.routine['id'])
        self.assertEqual(TeamService(storage).get(self.team['id'])['prompt'], 'Trabajo en equipo guardado')
        self.assertEqual(ConnectorService(storage).user_id(), self.connector_id)
        self.assertEqual((self.root / 'workspace/notes.txt').read_text(), 'Archivo de trabajo persistente')
        self.assertTrue(restored.restored)
        for path in (self.root / '.encryption.key', self.root / 'open-dots.sqlite3', self.root / '.auth-token'):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    async def test_real_whatsapp_signal_credentials_survive_encrypted_snapshot_and_restore(self):
        module = Path(__file__).resolve().parents[2] / 'whatsapp/auth-store.mjs'
        if not (module.parent / 'node_modules').exists():
            self.skipTest('WhatsApp dependencies not installed')
        script = "import { AuthStore } from " + json.dumps(module.as_uri()) + "; const store = new AuthStore(process.argv[1]); store.data.creds.testSecret = 'fixture-session-private'; await store.auth().keys.set({session: {fixture: Buffer.from([1,2,3])}});"
        subprocess.run(['node', '--input-type=module', '-e', script, str(self.root / 'whatsapp')], check=True, capture_output=True)
        self.backup.sync()
        self.assertNotIn(b'fixture-session-private', self.remote.payload)
        destination = Path(self.temp.name) / 'restored-wa'
        restored = self.service(destination); restored.bootstrap()
        check = "import { AuthStore } from " + json.dumps(module.as_uri()) + "; const store = new AuthStore(process.argv[1]); if (store.data.creds.testSecret !== 'fixture-session-private') throw Error('missing creds'); const keys=await store.auth().keys.get('session',['fixture']); if (keys.fixture.toString('hex') !== '010203') throw Error('missing Signal keys');"
        subprocess.run(['node', '--input-type=module', '-e', check, str(destination / 'whatsapp')], check=True, capture_output=True)
        self.assertEqual((destination / 'whatsapp/session.key').stat().st_mode & 0o777, 0o600)

    async def test_unchanged_state_creates_no_extra_commit_and_changed_notes_are_saved(self):
        self.backup.sync()
        first = self.remote.sha
        self.backup.sync()
        self.assertEqual(self.remote.sha, first)
        self.assertEqual(len([c for c in self.remote.calls if c[0] == 'PUT']), 1)
        MemoryService(self.storage).save(self.ids[0], 'Nueva nota')
        self.backup.sync()
        self.assertNotEqual(self.remote.sha, first)

    async def test_network_failure_preserves_remote_snapshot_and_reports_pending(self):
        self.backup.sync()
        first = self.remote.payload
        self.storage.save_settings({'theme': 'light'})
        self.remote.fail = True
        with self.assertRaises(BackupError): self.backup.sync()
        self.assertEqual(self.remote.payload, first)
        self.assertTrue(self.backup.status()['pending'])
        self.assertTrue(self.backup.status()['error'])
        self.remote.fail = False
        self.backup.sync()
        self.assertFalse(self.backup.status()['error'])

    async def test_restart_uses_unsynced_local_changes_when_remote_matches_previous_copy(self):
        self.backup.sync()
        self.storage.save_settings({'theme': 'light'})
        restarted = self.service(self.root); restarted.bootstrap()
        self.assertEqual(StorageService(self.root).get_settings()['theme'], 'light')
        restarted.sync()
        destination = Path(self.temp.name) / 'new-disk'
        restored = self.service(destination); restored.bootstrap()
        self.assertEqual(StorageService(destination).get_settings()['theme'], 'light')

    async def test_wrong_recovery_key_or_corruption_stops_restore_and_never_overwrites_remote(self):
        self.backup.sync()
        first = self.remote.payload
        for payload, key in ((first, 'different-key-outside-github-1234567890'), (first[:-8] + b'invalid!', self.owner)):
            self.remote.payload = payload
            destination = Path(self.temp.name) / 'invalid-disk'
            with self.assertRaises(BackupError):
                self.service(destination, {**self.environment, 'APP_AUTH_TOKEN': key}).bootstrap()
            self.assertFalse((destination / 'open-dots.sqlite3').exists())
        self.assertEqual(len([c for c in self.remote.calls if c[0] == 'PUT']), 1)

    async def test_conflicting_writer_and_untracked_local_data_do_not_replace_good_data(self):
        self.backup.sync()
        copy = self.service(Path(self.temp.name) / 'other-instance'); copy.bootstrap()
        self.storage.save_settings({'theme': 'light'}); self.backup.sync()
        latest = self.remote.payload
        StorageService(copy.root).save_settings({'theme': 'midnight'})
        with self.assertRaises(BackupError): copy.sync()
        self.assertEqual(self.remote.payload, latest)
        untracked = Path(self.temp.name) / 'untracked'
        StorageService(untracked)
        with self.assertRaisesRegex(BackupError, 'datos locales'): self.service(untracked).bootstrap()

    async def test_archive_excludes_videos_logs_and_files_outside_workspace(self):
        (self.root / 'youtube-uploads').mkdir(); (self.root / 'youtube-uploads/video.mp4').write_bytes(b'private-video')
        (self.root / 'server.log').write_text('private-log')
        (self.root / 'workspace/link').symlink_to(self.root / 'server.log')
        payload, _ = self.backup.capture()
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            self.assertNotIn('youtube-uploads/video.mp4', archive.namelist())
            self.assertNotIn('server.log', archive.namelist())
            self.assertNotIn('workspace/link', archive.namelist())

    async def test_zip_path_traversal_and_excessive_file_sizes_are_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('../outside.txt', 'unsafe')
            archive.writestr('manifest.json', '{}')
        with self.assertRaises(BackupError): self.backup.unpack(self.backup.encrypt(buffer.getvalue()))
        (self.root / 'workspace/large').write_bytes(b'x' * (1024 * 1024 + 1))
        with self.assertRaises(BackupError): self.backup.capture()

    async def test_missing_whatsapp_key_does_not_replace_previous_snapshot(self):
        self.backup.sync(); before = self.remote.payload
        (self.root / 'whatsapp').mkdir(); (self.root / 'whatsapp/session.enc').write_bytes(b'fixture-session')
        with self.assertRaises(BackupError): self.backup.sync()
        self.assertEqual(self.remote.payload, before)

    async def test_interrupted_restore_finishes_before_opening_partial_local_database(self):
        self.backup.sync()
        destination = Path(self.temp.name) / 'partial-disk'
        destination.mkdir()
        # A crash after replacing SQLite and before replacing its encryption key.
        (destination / 'open-dots.sqlite3').write_bytes(b'incomplete-local-file')
        (destination / '.github-restore.json').write_text(json.dumps({'sha': self.remote.sha}))
        restored = self.service(destination); restored.bootstrap()
        self.assertEqual(StorageService(destination).get_settings()['composio_api_key'], 'fixture-composio-private')
        self.assertFalse((destination / '.github-restore.json').exists())

    async def test_large_github_content_uses_blob_endpoint_without_untrusted_redirect(self):
        self.backup.sync()
        original = self.remote.request
        def metadata(method, path, **kwargs):
            if method == 'GET' and path == '/contents/dots-state.enc':
                return {'encoding': 'none', 'size': len(self.remote.payload), 'sha': self.remote.sha, 'download_url': 'https://untrusted.example.test/file'}
            return original(method, path, **kwargs)
        destination = Path(self.temp.name) / 'blob-disk'
        restored = self.service(destination); restored.request = metadata; restored.bootstrap()
        self.assertTrue(restored.restored)
        self.assertTrue(any(path.startswith('/git/blobs/') for method, path, kwargs in self.remote.calls))

    async def test_shutdown_flushes_final_changes(self):
        await self.backup.start()
        self.storage.save_settings({'theme': 'midnight'})
        await self.backup.stop()
        destination = Path(self.temp.name) / 'shutdown-disk'
        restored = self.service(destination); restored.bootstrap()
        self.assertEqual(StorageService(destination).get_settings()['theme'], 'midnight')

    async def test_owner_only_status_sync_and_download_never_return_bootstrap_secrets(self):
        transport = httpx.ASGITransport(app=app)
        with patch.object(persistence, 'backup_service', self.backup):
            with patch('app.main.auth_service.authenticate_request', return_value=None):
                async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
                    for path in ('status', 'download'):
                        self.assertEqual((await client.get('/api/v1/persistence/' + path)).status_code, 401)
                    self.assertEqual((await client.post('/api/v1/persistence/sync')).status_code, 401)
            with patch('app.main.auth_service.authenticate_request', return_value={'id': 'local-user'}):
                async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
                    status = await client.get('/api/v1/persistence/status')
                    self.assertEqual(status.status_code, 200)
                    self.assertEqual(status.headers['cache-control'], 'no-store')
                    self.assertNotIn(self.owner, status.text)
                    self.assertNotIn(self.environment['GITHUB_BACKUP_TOKEN'], status.text)
                    response = await client.get('/api/v1/persistence/download')
                    self.assertTrue(response.content.startswith(MAGIC))
                    self.assertEqual(response.headers['cache-control'], 'no-store')
                    self.assertNotIn(b'fixture-composio-private', response.content)

    async def test_github_http_contract_uses_contents_branch_and_sanitizes_errors(self):
        service = GitHubBackup(self.root, self.environment)
        def handler(request):
            self.assertEqual(request.headers['authorization'], 'Bearer fixture-private-github-token')
            self.assertEqual(str(request.url), 'https://api.github.com/repos/fixture/dots/contents/dots-state.enc')
            self.assertEqual(json.loads(request.content)['branch'], 'dots-data')
            return httpx.Response(403, json={'message': 'fixture-private-github-token'})
        client = httpx.Client(transport=httpx.MockTransport(handler))
        with patch('app.services.github_backup.httpx.Client', return_value=client):
            with self.assertRaises(BackupError) as raised:
                service.request('PUT', '/contents/dots-state.enc', json={'branch': 'dots-data', 'content': 'fixture'})
        self.assertNotIn('fixture-private-github-token', str(raised.exception))

    def test_remote_configuration_requires_valid_repository_and_stable_key(self):
        for change, field in (({'APP_AUTH_TOKEN': ''}, 'DATA_BACKUP_KEY'), ({'APP_AUTH_TOKEN': 'short'}, 'DATA_BACKUP_KEY'),
                              ({'GITHUB_BACKUP_REPOSITORY': '../bad'}, 'GITHUB_BACKUP_REPOSITORY'), ({'GITHUB_BACKUP_REPOSITORY': ''}, 'GITHUB_BACKUP_REPOSITORY'),
                              ({'DATA_BACKUP_KEY': 'short'}, 'DATA_BACKUP_KEY')):
            service = self.service(self.root, {**self.environment, **change})
            with self.subTest(change=change):
                service.bootstrap()
                self.assertFalse(service.status()['configured'])
                self.assertIn(field, service.status()['error'])
                self.assertNotIn(self.environment['GITHUB_BACKUP_TOKEN'], service.status()['error'])
                with self.assertRaisesRegex(BackupError, field): service.sync()
                self.assertFalse(self.remote.calls)
        self.assertFalse(GitHubBackup(self.root, {}).status()['configured'])

    async def test_invalid_configuration_pauses_workers_and_preserves_previous_copy(self):
        self.backup.sync()
        previous = self.remote.payload
        previous_calls = list(self.remote.calls)
        paused = self.service(self.root, {**self.environment, 'APP_AUTH_TOKEN': 'short'})
        paused.bootstrap()
        await paused.start()
        self.assertIsNone(paused.worker)
        self.storage.save_settings({'theme': 'light'})
        await paused.stop()
        self.assertEqual(self.remote.payload, previous)
        self.assertEqual(self.remote.calls, previous_calls)
        self.assertEqual(StorageService(self.root).get_settings()['theme'], 'light')

    async def test_independent_recovery_key_preserves_short_owner_password(self):
        env = {**self.environment, 'APP_AUTH_TOKEN': 'short-owner-password', 'DATA_BACKUP_KEY': 'fixture-independent-recovery-key-1234567890'}
        service = self.service(self.root, env)
        service.bootstrap(); service.sync()
        restored = self.service(Path(self.temp.name) / 'independent-key-disk', env)
        restored.bootstrap()
        self.assertEqual(StorageService(restored.root).get_settings()['model_api_key'], 'fixture-nvidia-private')
        self.assertTrue(restored.status()['configured'])
        self.assertEqual(env['APP_AUTH_TOKEN'], 'short-owner-password')
        blank_override = self.service(self.root, {**self.environment, 'DATA_BACKUP_KEY': '   '})
        self.assertEqual(blank_override.secret, self.owner)

    def test_cold_server_starts_with_incomplete_backup_configuration_and_reports_error_privately(self):
        script = '''
import asyncio
import httpx
from unittest.mock import patch
with patch('app.services.github_backup.GitHubBackup.request', side_effect=AssertionError('No GitHub calls with invalid configuration')) as remote:
    from app.main import app, backup_service
    async def check():
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver') as client:
                assert (await client.get('/api/v1/health')).status_code == 200
                assert (await client.get('/api/v1/persistence/status')).status_code == 401
                client.headers['Authorization'] = 'Bearer short-owner-password'
                response = await client.get('/api/v1/persistence/status')
                assert response.status_code == 200
                assert response.headers['cache-control'] == 'no-store'
                assert response.json()['configured'] is False
                assert 'DATA_BACKUP_KEY' in response.json()['error']
                assert 'fixture-private-github-token' not in response.text
                assert 'short-owner-password' not in response.text
                failure = await client.post('/api/v1/persistence/sync')
                assert failure.status_code == 409 and 'DATA_BACKUP_KEY' in failure.text
                assert backup_service.worker is None
    asyncio.run(check())
    assert remote.call_count == 0
'''
        env = {**os.environ, **self.environment, 'APP_AUTH_TOKEN': 'short-owner-password', 'DATA_BACKUP_KEY': '',
               'DATA_DIR': str(Path(self.temp.name) / 'cold-server'), 'COMPUTER_PROVIDER': 'fake',
               'MODEL_API_KEY': '', 'NVIDIA_API_KEY': '', 'COMPOSIO_API_KEY': '', 'YDC_API_KEY': ''}
        result = subprocess.run([sys.executable, '-c', script], env=env, cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
