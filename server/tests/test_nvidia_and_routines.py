import json
import tempfile
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta
from unittest.mock import patch
import httpx
from pydantic import ValidationError

from app.services.provider_service import ModelProviderService
from app.services.memory_service import MemoryService
from app.services.storage_service import StorageService
from app.services.routine_service import RoutineService
from app.services.agent_service import run_agent
from app.services.agent_service import execute_schedule
from app.services.action_gateway import ActionGateway, ActionInvocation, ActionDefinition, ActionGatewayError
from test_action_gateway import ImmediateApprovalBroker
from app.routers.agent_state import RoutineInput


class NvidiaTests(unittest.IsolatedAsyncioTestCase):
    async def run_provider(self, chunks=None, status=200, done=True):
        self.requests = []
        def handler(request):
            self.requests.append(request)
            return httpx.Response(status, text=''.join('data: ' + json.dumps(chunk) + '\n\n' for chunk in chunks or []) + ('data: [DONE]\n\n' if done else ''), headers={'content-type': 'text/event-stream'})
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with patch('app.services.provider_service.storage_service.get_settings', return_value={
            'model_api_key': 'private-test-key', 'model_api_base_url': 'https://integrate.api.nvidia.com/v1',
            'model_api_wire_api': 'chat_completions',
        }), patch('app.services.provider_service.httpx.AsyncClient', return_value=client):
            return [e async for e in ModelProviderService().stream_chat_completion('meta/llama-3.3-70b-instruct', [
                {'role': 'user', 'content': 'Hola'}, {'role': 'assistant', 'content': 'Hola, ¿qué necesitas?'},
                {'role': 'user', 'content': 'Recuerda español'},
            ], 'Habla español', tools=[{'type': 'function', 'function': {'name': 'remember'}}])]

    async def test_nvidia_request_keeps_history_and_exact_model(self):
        events = await self.run_provider([
            {'choices': [{'index': 0, 'delta': {'content': 'Hola'}}]},
            {'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]},
        ])
        request = self.requests[0]
        self.assertEqual(str(request.url), 'https://integrate.api.nvidia.com/v1/chat/completions')
        self.assertEqual(request.headers['authorization'], 'Bearer private-test-key')
        body = json.loads(request.content)
        self.assertEqual(body['model'], 'meta/llama-3.3-70b-instruct')
        self.assertEqual(len(body['messages']), 4)
        self.assertEqual(body['messages'][0], {'role': 'system', 'content': 'Habla español'})
        self.assertEqual(body['tool_choice'], 'auto')
        self.assertEqual(events[-1], {'type': 'turn.completed', 'ok': True})

    async def test_fragmented_tool_arguments_are_assembled(self):
        events = await self.run_provider([
            {'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'call-1', 'function': {'name': 'remember', 'arguments': '{"text":'}}]}}]},
            {'choices': [{'delta': {'tool_calls': [{'index': 0, 'function': {'arguments': '"español"}'}}]}, 'finish_reason': 'tool_calls'}]},
        ])
        self.assertEqual(events[-1]['type'], 'tool.call')
        self.assertEqual(json.loads(events[-1]['calls'][0]['function']['arguments']), {'text': 'español'})

    async def test_truncated_and_output_limit_streams_fail(self):
        for done, reason in [(False, 'stop'), (True, 'length'), (True, None)]:
            events = await self.run_provider([{'choices': [{'delta': {}, 'finish_reason': reason}]}], done=done)
            self.assertFalse(events[-1]['ok'])

    async def test_auth_error_is_visible_without_leaking_key(self):
        events = await self.run_provider(status=401)
        self.assertIn('401', events[0]['delta'])
        self.assertNotIn('private-test-key', json.dumps(events))
        self.assertFalse(events[-1]['ok'])


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def test_agent_executes_tool_and_passes_result_back_to_model(self):
        with tempfile.TemporaryDirectory() as d:
            memory = MemoryService(StorageService(Path(d)))
            captured = []
            async def model(**kwargs):
                captured.append(kwargs)
                if len(captured) == 1:
                    yield {'type': 'tool.call', 'calls': [{'id': 'c1', 'type': 'function', 'function': {'name': 'remember', 'arguments': '{"text":"Prefiero español"}'}}]}
                else:
                    yield {'type': 'content.delta', 'delta': 'Recordado.'}
                    yield {'type': 'turn.completed', 'ok': True}
            with patch('app.services.agent_service.memory_service', memory), \
                 patch('app.services.agent_service.provider_service.stream_chat_completion', model), \
                 patch('app.services.agent_service.storage_service.get_settings', return_value={'model_api_wire_api': 'chat_completions'}):
                events = [e async for e in run_agent('bot-test', 'exact-model', [{'role': 'user', 'content': 'Recuerda español'}], 'Eres Dot')]
            self.assertEqual(memory.list('bot-test')[0]['text'], 'Prefiero español')
            self.assertEqual(captured[1]['messages'][-1]['role'], 'tool')
            self.assertTrue(events[-1]['ok'])

    async def test_background_worker_never_offers_write_or_computer_tools(self):
        captured = {}
        async def model(**kwargs):
            captured.update(kwargs)
            yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', model), \
             patch('app.services.agent_service.storage_service.get_settings', return_value={'model_api_wire_api': 'chat_completions'}):
            _ = [e async for e in run_agent('test', 'model', [], 'Prompt', background=True)]
        self.assertEqual([t['function']['name'] for t in captured['tools']], ['search_web'])


class DurableStateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.routines = RoutineService(self.storage)
        self.bot_id = self.storage.get_bots()[0]['id']

    async def asyncTearDown(self):
        await self.routines.stop()
        self.directory.cleanup()

    async def test_memories_persist_and_are_scoped_to_bot(self):
        memory = MemoryService(self.storage)
        item = memory.save(self.bot_id, 'Prefiero tablas')
        reopened = MemoryService(StorageService(Path(self.directory.name)))
        self.assertEqual(reopened.list(self.bot_id)[0]['text'], 'Prefiero tablas')
        self.assertEqual(reopened.list('another-bot'), [])
        self.assertFalse(reopened.delete('another-bot', item['id']))
        self.assertTrue(reopened.delete(self.bot_id, item['id']))
        self.assertEqual(reopened.list(self.bot_id), [])

    async def test_claim_is_durable_and_only_runs_once(self):
        task = self.routines.create(self.bot_id, 'Tarea', 'Hola', datetime.now(timezone.utc))
        first = self.routines.claim_due()
        self.assertEqual(first['id'], task['id'])
        another_worker = RoutineService(StorageService(Path(self.directory.name)))
        self.assertIsNone(another_worker.claim_due())
        self.assertEqual(another_worker.list()[0]['status'], 'running')

    async def test_future_and_paused_tasks_are_not_claimed(self):
        self.routines.create(self.bot_id, 'Futura', 'Hola', datetime.now(timezone.utc) + timedelta(days=1))
        task = self.routines.create(self.bot_id, 'Ahora', 'Hola', datetime.now(timezone.utc))
        self.routines.change(task['id'], 'pause')
        self.assertIsNone(self.routines.claim_due())
        self.routines.change(task['id'], 'run')
        self.assertEqual(self.routines.claim_due()['id'], task['id'])

    async def test_results_reach_chat_and_failures_stop_recurrence(self):
        for ok in (True, False):
            with self.subTest(ok=ok):
                task = self.routines.create(self.bot_id, 'Resumen', 'Resume mis metas', datetime.now(timezone.utc), 3600)
                async def agent(*args, **kwargs):
                    self.assertTrue(kwargs['background'])
                    yield {'type': 'content.delta', 'delta': 'Resultado probado'}
                    yield {'type': 'turn.completed', 'ok': ok}
                with patch('app.services.routine_service.run_agent', agent):
                    await self.routines.tick()
                stored = next(t for t in self.routines.list() if t['id'] == task['id'])
                self.assertEqual(stored['status'], 'queued' if ok else 'failed')
                self.assertEqual(stored['last_result'], 'Resultado probado')
                self.assertIn('Resultado probado', self.storage.get_messages(self.bot_id)[-1]['text'])

    async def test_restart_reports_interruption_without_replaying(self):
        self.routines.create(self.bot_id, 'Test', 'Prompt', datetime.now(timezone.utc))
        self.routines.claim_due()
        await self.routines.start()
        await self.routines.stop()
        self.assertEqual(self.routines.list()[0]['status'], 'failed')

    async def test_running_task_cannot_be_deleted_or_paused(self):
        task = self.routines.create(self.bot_id, 'Test', 'Prompt', datetime.now(timezone.utc))
        self.routines.claim_due()
        for action in ['pause', 'delete', 'run']:
            with self.assertRaises(ValueError):
                self.routines.change(task['id'], action)

    async def test_schedule_requires_timezone_and_sensible_interval(self):
        base = {'bot_id': self.bot_id, 'name': 'Test', 'prompt': 'Test'}
        with self.assertRaises(ValidationError):
            RoutineInput(**base, run_at='2026-10-07T08:00:00')
        with self.assertRaises(ValidationError):
            RoutineInput(**base, run_at='2026-10-07T08:00:00Z', interval_seconds=5)

    async def test_chat_schedule_cannot_create_task_before_approval(self):
        gateway = ActionGateway(approvals=ImmediateApprovalBroker(), audit=self.storage)
        gateway.register_action(ActionDefinition(name='routine.schedule', tool='routine', action='schedule',
            intent='Schedule a routine', risk='write', requires_approval=True), execute_schedule)
        invocation = ActionInvocation(name='routine.schedule', arguments={'bot_id': self.bot_id, 'name': 'Approved task',
            'prompt': 'Read-only summary', 'run_at': '2026-10-07T09:00:00+02:00', 'interval_seconds': None},
            target={'bot_id': self.bot_id}, preview='Tomorrow at 9am')
        request, approval = gateway.open(self.bot_id, self.bot_id, invocation)
        self.assertIsNotNone(approval)
        with patch('app.services.routine_service.routine_service', self.routines):
            with self.assertRaises(ActionGatewayError):
                await gateway.execute(request)
            self.assertEqual(self.routines.list(), [])
            await gateway.wait_for_decision(request)
            result = await gateway.execute(request)
        self.assertEqual(result.status, 'completed')
        self.assertEqual(self.routines.list()[0]['name'], 'Approved task')
