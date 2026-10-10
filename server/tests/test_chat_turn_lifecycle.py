import asyncio
from contextlib import ExitStack
import json
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import httpx

from app.main import app
from app.routers import chat
from app.services.auth_service import auth_service
from app.services.storage_service import StorageService


class ChatTurnLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.bot = self.storage.get_bots()[0]
        self.calls = []
        self.patches = ExitStack()
        self.patches.enter_context(patch.object(chat, 'storage_service', self.storage))
        chat._active_turns.clear()
        chat._finished_turns.clear()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=('127.0.0.1', 12345)), base_url='http://127.0.0.1')
        await self.client.post('/api/v1/auth/login', json={'token': auth_service.token})
        await self.send('Envíame por WhatsApp cuánto es 2+2.')
        self.initial_history = self.storage.get_messages(self.bot['id'])

    async def asyncTearDown(self):
        await self.client.aclose()
        self.patches.close()
        chat._active_turns.clear()
        chat._finished_turns.clear()
        self.directory.cleanup()

    async def send(self, text):
        response = await self.client.post('/api/v1/chat/send', json={'thread_id': self.bot['id'], 'bot_id': self.bot['id'], 'user_text': text})
        self.assertEqual(response.status_code, 200)
        return response.json()['message']

    async def finished_runner(self, **kwargs):
        self.calls.append(kwargs)
        yield {'type': 'turn.progress', 'stage': 'generating', 'label': 'Generando respuesta…'}
        yield {'type': 'content.delta', 'delta': 'WhatsApp ha aceptado el mensaje.'}
        yield {'type': 'turn.completed', 'ok': True}

    async def stream_response(self, suffix=''):
        return await self.client.get('/api/v1/chat/stream/' + self.bot['id'] + suffix)

    def events(self, response):
        return [json.loads(line[5:]) for line in response.text.splitlines() if line.startswith('data:')]

    async def test_voice_query_reaches_agent_and_preserves_selected_model(self):
        with patch.object(chat, 'run_agent', self.finished_runner):
            response = await self.stream_response('?response_mode=voice&model=exact-selected-model')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.calls[0]['response_mode'], 'voice')
        self.assertEqual(self.calls[0]['model'], 'exact-selected-model')
        self.assertTrue(self.events(response)[-1]['ok'])

    async def test_reconnecting_completed_stream_does_not_run_another_turn(self):
        with patch.object(chat, 'run_agent', self.finished_runner):
            first = await self.stream_response()
            repeat = await self.stream_response()
            await self.send('Haz una nueva petición.')
            next_turn = await self.stream_response()
        self.assertTrue(self.events(first)[-1]['ok'])
        self.assertFalse(self.events(repeat)[-1]['ok'])
        self.assertIn('No se ha repetido ningún envío', self.events(repeat)[1]['delta'])
        self.assertTrue(self.events(next_turn)[-1]['ok'])
        self.assertEqual(len(self.calls), 2)

    async def test_failed_approved_dispatch_cannot_be_replayed_by_reopening_same_stream(self):
        async def uncertain(**kwargs):
            self.calls.append(kwargs)
            yield {'type': 'tool.started', 'tool': 'whatsapp_owner', 'requestId': 'fixture-request'}
            yield {'type': 'tool.failed', 'tool': 'whatsapp_owner', 'error': 'Resultado no confirmado.'}
            yield {'type': 'content.delta', 'delta': 'Revisa WhatsApp antes de repetirlo.'}
            yield {'type': 'turn.completed', 'ok': False}
        with patch.object(chat, 'run_agent', uncertain):
            first = await self.stream_response()
            repeat = await self.stream_response()
        self.assertFalse(self.events(first)[-1]['ok'])
        self.assertFalse(self.events(repeat)[-1]['ok'])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.storage.get_messages(self.bot['id']), self.initial_history)

    async def test_second_stream_cannot_start_while_first_turn_is_active(self):
        with patch.object(chat, 'run_agent', self.finished_runner):
            first = await chat.stream_turn(self.bot['id'], model=None, response_mode='text')
            initial = await first.body_iterator.__anext__()
            self.assertEqual(json.loads(initial['data'])['type'], 'turn.started')
            second = await chat.stream_turn(self.bot['id'], model=None, response_mode='text')
            duplicate = [event async for event in second.body_iterator]
            self.assertFalse(json.loads(duplicate[-1]['data'])['ok'])
            self.assertEqual(len(self.calls), 0)
            await first.body_iterator.aclose()
            self.assertNotIn(self.bot['id'], chat._active_turns)
            await self.send('Una nueva petición después de parar la anterior.')
            retry = await self.stream_response()
        self.assertTrue(self.events(retry)[-1]['ok'])
        self.assertEqual(len(self.calls), 1)

    async def test_invalid_voice_mode_is_rejected_before_inference(self):
        with patch.object(chat, 'run_agent', self.finished_runner):
            response = await self.stream_response('?response_mode=unexpected')
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.calls, [])

    async def test_uncertain_dispatch_is_not_replayed_after_process_registry_is_lost(self):
        async def uncertain(**kwargs):
            self.calls.append(kwargs)
            yield {'type': 'tool.started', 'tool': 'whatsapp_owner', 'requestId': 'fixture-request'}
            yield {'type': 'content.delta', 'delta': 'Resultado de envío no confirmado.'}
            yield {'type': 'turn.completed', 'ok': False}
        with patch.object(chat, 'run_agent', uncertain):
            await self.stream_response()
            chat._active_turns.clear()
            chat._finished_turns.clear()
            reopened = StorageService(Path(self.directory.name))
            with patch.object(chat, 'storage_service', reopened):
                blocked = await self.stream_response()
                await self.send('Pide un nuevo mensaje tras comprobar WhatsApp.')
                await self.stream_response()
        self.assertFalse(self.events(blocked)[-1]['ok'])
        self.assertEqual(len(self.calls), 2)
        record = reopened.get_chat_turn(self.bot['id'], self.initial_history[-1]['id'])
        self.assertEqual(record['status'], 'failed')

    async def test_started_turn_from_interrupted_server_remains_reserved_without_running_again(self):
        message_id = self.initial_history[-1]['id']
        self.assertTrue(self.storage.claim_chat_turn(self.bot['id'], message_id))
        reopened = StorageService(Path(self.directory.name))
        with patch.object(chat, 'storage_service', reopened), patch.object(chat, 'run_agent', self.finished_runner):
            response = await self.stream_response()
        self.assertFalse(self.events(response)[-1]['ok'])
        self.assertEqual(self.calls, [])
        self.assertEqual(reopened.get_chat_turn(self.bot['id'], message_id)['status'], 'started')

    async def test_cancelling_before_inference_does_not_make_same_user_turn_replayable(self):
        response = await chat.stream_turn(self.bot['id'], model=None, response_mode='text')
        await response.body_iterator.__anext__()
        await response.body_iterator.aclose()
        chat._active_turns.clear()
        chat._finished_turns.clear()
        with patch.object(chat, 'run_agent', self.finished_runner):
            blocked = await self.stream_response()
        self.assertFalse(self.events(blocked)[-1]['ok'])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.storage.get_chat_turn(self.bot['id'], self.initial_history[-1]['id'])['status'], 'cancelled')

    async def test_two_storage_instances_cannot_claim_same_turn_concurrently(self):
        reopened = StorageService(Path(self.directory.name))
        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = list(executor.map(lambda storage: storage.claim_chat_turn(self.bot['id'], 'fixture-concurrent-user-message'), [self.storage, reopened]))
        self.assertEqual(sorted(claims), [False, True])

    async def test_exact_user_message_runs_despite_routine_appended_before_stream(self):
        message_id = self.initial_history[-1]['id']
        self.storage.add_message({
            'id': 'fixture-routine-result', 'thread_id': self.bot['id'], 'bot_id': self.bot['id'],
            'sender': 'bot', 'text': 'Resultado de una rutina en segundo plano.',
            'created_at': '2026-10-10T18:00:00',
        })
        with patch.object(chat, 'run_agent', self.finished_runner):
            response = await self.stream_response('?message_id=' + message_id)
        self.assertTrue(self.events(response)[-1]['ok'])
        self.assertEqual(self.calls[0]['messages'][-1]['id'], message_id)
        self.assertEqual(self.calls[0]['messages'][-1]['content'], 'Envíame por WhatsApp cuánto es 2+2.')

    async def test_stream_uses_submitted_message_and_never_newer_tab_request(self):
        first_id = self.initial_history[-1]['id']
        second = await self.send('Una pregunta nueva de otra pestaña.')
        with patch.object(chat, 'run_agent', self.finished_runner):
            first = await self.stream_response('?message_id=' + first_id)
            second_response = await self.stream_response('?message_id=' + second['id'])
            repeat = await self.stream_response('?message_id=' + first_id)
        self.assertTrue(self.events(first)[-1]['ok'])
        self.assertTrue(self.events(second_response)[-1]['ok'])
        self.assertFalse(self.events(repeat)[-1]['ok'])
        self.assertEqual([call['messages'][-1]['id'] for call in self.calls], [first_id, second['id']])

    async def test_nonexistent_or_assistant_message_id_does_not_start_inference(self):
        with patch.object(chat, 'run_agent', self.finished_runner):
            self.assertEqual((await self.stream_response('?message_id=missing')).status_code, 404)
            await self.stream_response()
            assistant_id = self.storage.get_messages(self.bot['id'])[-1]['id']
            self.assertEqual((await self.stream_response('?message_id=' + assistant_id)).status_code, 404)
        self.assertEqual(len(self.calls), 1)

    async def test_identical_explicit_requests_have_independent_turns(self):
        ids = [self.initial_history[-1]['id']]
        with patch.object(chat, 'run_agent', self.finished_runner):
            for attempt in range(5):
                if attempt:
                    message = await self.send('Envíame por WhatsApp cuánto es 2+2.')
                    ids.append(message['id'])
                response = await self.stream_response('?message_id=' + ids[-1])
                self.assertTrue(self.events(response)[-1]['ok'])
        self.assertEqual(len(set(ids)), 5)
        self.assertEqual(len(self.calls), 5)

    async def test_terminal_event_releases_turn_before_slow_provider_cleanup(self):
        cleanup_started = asyncio.Event()
        cleanup_release = asyncio.Event()

        async def slow_cleanup_runner(**kwargs):
            try:
                yield {'type': 'content.delta', 'delta': 'WhatsApp ha aceptado el mensaje.'}
                yield {'type': 'turn.completed', 'ok': True}
            finally:
                cleanup_started.set()
                await cleanup_release.wait()

        with patch.object(chat, 'run_agent', slow_cleanup_runner):
            first = await chat.stream_turn(self.bot['id'], model=None, response_mode='text')
            while True:
                event = await first.body_iterator.__anext__()
                if json.loads(event['data'])['type'] == 'turn.completed':
                    break
            self.assertNotIn(self.bot['id'], chat._active_turns)
            self.assertEqual(self.storage.get_chat_turn(self.bot['id'], self.initial_history[-1]['id'])['status'], 'completed')

            second_message = await self.send('Envíame por WhatsApp cuánto es 3+3.')
            second = await chat.stream_turn(self.bot['id'], model=None, response_mode='text', message_id=second_message['id'])
            event = await second.body_iterator.__anext__()
            self.assertEqual(json.loads(event['data'])['type'], 'turn.started')
            self.assertEqual(chat._active_turns[self.bot['id']], second_message['id'])

            closing_first = asyncio.create_task(first.body_iterator.aclose())
            await asyncio.wait_for(cleanup_started.wait(), timeout=1)
            cleanup_release.set()
            await asyncio.wait_for(closing_first, timeout=1)
            # Cleanup from the earlier response cannot clear the new reservation.
            self.assertEqual(chat._active_turns[self.bot['id']], second_message['id'])
            await second.body_iterator.aclose()
            self.assertNotIn(self.bot['id'], chat._active_turns)
