import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from pydantic import ValidationError

from app.main import app
from app.routers import team
from app.schemas.team import TeamInput
from app.schemas.contracts import AppSettingsSchema
from app.services.auth_service import auth_service
from app.services.agent_service import run_agent
from app.services.storage_service import StorageService
from app.services.team_service import TeamService


class TeamTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.directory.name))
        self.storage.save_settings({'model_api_key': 'fixture-model-secret'})
        self.calls = []
        self.fail_ids = set()
        self.gate = None
        self.started = asyncio.Event()
        self.concurrent = self.max_concurrent = 0
        async def runner(bot_id, model, messages, system_prompt, *, background=False):
            self.calls.append((bot_id, model, messages, system_prompt, background))
            self.concurrent += 1
            self.max_concurrent = max(self.max_concurrent, self.concurrent)
            self.started.set()
            try:
                await asyncio.sleep(0)
                if self.gate: await self.gate.wait()
                if bot_id in self.fail_ids:
                    yield {'type': 'turn.completed', 'ok': False}; return
                if 'Eres el coordinador.' in system_prompt:
                    text = 'Resultado final que integra los análisis y las revisiones.'
                elif 'Revisa las aportaciones' in system_prompt:
                    text = 'Revisión de ' + bot_id + ': ideas contrastadas y corregidas.'
                else:
                    text = 'Análisis de ' + bot_id + ': primera propuesta.'
                yield {'type': 'content.delta', 'delta': text}
                yield {'type': 'turn.completed', 'ok': True}
            finally:
                self.concurrent -= 1
        self.service = TeamService(self.storage, runner)
        self.ids = [b['id'] for b in self.storage.get_bots()[:3]]
        self.input = TeamInput(prompt='Preparad un plan para mi canal.', bot_ids=self.ids, coordinator_id=self.ids[0])
        self.patch = patch.object(team, 'team_service', self.service); self.patch.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1')
        self.auth = {'Authorization': 'Bearer ' + auth_service.token}

    async def asyncTearDown(self):
        await self.service.stop()
        await self.client.aclose()
        self.patch.stop(); self.directory.cleanup()

    async def test_members_share_and_review_contributions_before_real_final_synthesis(self):
        created = self.service.create(self.input)
        self.assertNotIn('rules', created['members'][0])
        item = self.service.claim(); await self.service.execute(item)
        result = self.service.get(item['id'])
        self.assertEqual(result['status'], 'completed')
        self.assertEqual(len(self.calls), 7)  # 3 analyses, 3 peer reviews, 1 synthesis.
        self.assertLessEqual(self.max_concurrent, 2)
        reviews = [c for c in self.calls if 'Revisa las aportaciones' in c[3]]
        self.assertEqual(len(reviews), 3)
        for bot_id, _, messages, _, background in reviews:
            self.assertTrue(background)
            for peer in self.ids:
                if peer != bot_id: self.assertIn('Análisis de ' + peer, messages[0]['content'])
        synthesis = self.calls[-1]
        self.assertEqual(synthesis[0], self.ids[0])
        self.assertTrue(synthesis[4])
        for peer in self.ids: self.assertIn('Revisión de ' + peer, synthesis[2][0]['content'])
        self.assertIn('Resultado final', result['result'])
        self.assertTrue(all(m['status'] == 'done' for m in result['members']))

    async def test_missing_contribution_is_reported_as_partial_not_fake_success(self):
        self.fail_ids.add(self.ids[-1])
        self.service.create(self.input)
        item = self.service.claim(); await self.service.execute(item)
        result = self.service.get(item['id'])
        self.assertEqual(result['status'], 'partial')
        self.assertTrue(result['members'][-1]['error'])
        self.assertIn('Resultado final', result['result'])

    async def test_provider_outage_cannot_produce_a_final_result(self):
        self.fail_ids.update(self.ids)
        self.service.create(self.input)
        item = self.service.claim(); await self.service.execute(item)
        result = self.service.get(item['id'])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['result'], '')
        self.assertNotIn('fixture-model-secret', json.dumps(result))

    async def test_cancel_propagates_to_all_running_members(self):
        self.gate = asyncio.Event()
        await self.service.start()
        item = self.service.create(self.input)
        await asyncio.wait_for(self.started.wait(), 3)
        result = await self.service.cancel(item['id'])
        self.assertEqual(result['status'], 'cancelled')
        self.assertEqual(result['result'], '')
        self.assertEqual(self.concurrent, 0)

    async def test_restart_reports_interruption_without_repeating_inference(self):
        created = self.service.create(self.input)
        self.service.claim()
        reopened = TeamService(self.storage, self.service.runner)
        await reopened.start(); await reopened.stop()
        self.assertEqual(reopened.get(created['id'])['status'], 'interrupted')
        self.assertEqual(self.calls, [])

    async def test_validation_and_queue_bound(self):
        with self.assertRaises(ValidationError): TeamInput(prompt='x', bot_ids=[self.ids[0]], coordinator_id=self.ids[0])
        with self.assertRaises(ValidationError): TeamInput(prompt='x', bot_ids=[self.ids[0]]*2, coordinator_id=self.ids[0])
        with self.assertRaises(ValueError): self.service.create(TeamInput(prompt='x', bot_ids=self.ids, coordinator_id='other'))
        with self.assertRaises(ValueError): self.service.create(TeamInput(prompt='x', bot_ids=[self.ids[0], 'missing'], coordinator_id=self.ids[0]))
        for _ in range(3): self.service.create(self.input)
        with self.assertRaises(ValueError): self.service.create(self.input)

    async def test_routes_require_owner_and_never_expose_saved_rules(self):
        root = '/api/v1/team/runs'
        self.assertEqual((await self.client.get(root)).status_code, 401)
        self.assertEqual((await self.client.post(root, json=self.input.model_dump())).status_code, 401)
        response = await self.client.post(root, json=self.input.model_dump(), headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('rules', response.json()['members'][0])
        run_id = response.json()['id']
        with self.storage.database.connect() as db: db.execute("UPDATE tasks SET owner_id = 'other-owner' WHERE id = ?", (run_id,))
        self.assertEqual((await self.client.get(root + '/' + run_id, headers=self.auth)).status_code, 404)

    async def test_cooperation_only_offers_read_only_search_tools(self):
        seen = []
        async def provider(**kwargs):
            seen.append(kwargs)
            yield {'type': 'content.delta', 'delta': 'Análisis.'}
            yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.provider_service.stream_chat_completion', provider), patch('app.services.agent_service.storage_service.get_settings', return_value={'model_api_wire_api': 'chat_completions'}), patch('app.services.agent_service.memory_service.context', return_value=''):
            events = [e async for e in run_agent(self.ids[0], 'fixture-model', [{'role': 'user', 'content': 'Analiza'}], 'Reglas', background=True)]
        self.assertTrue(events[-1]['ok'])
        self.assertEqual([t['function']['name'] for t in seen[0]['tools']], ['search_web'])

    async def test_appearance_is_validated_and_does_not_replace_provider_credentials(self):
        data = AppSettingsSchema(theme='light', theme_accent='mint', theme_density='compact', theme_motion='reduced')
        self.storage.save_settings(data.model_dump(exclude_unset=True))
        reopened = StorageService(Path(self.directory.name))
        self.assertEqual(reopened.get_settings()['theme'], 'light')
        self.assertEqual(reopened.get_settings()['model_api_key'], 'fixture-model-secret')
        self.assertEqual(reopened.get_settings()['theme_motion'], 'reduced')
        with self.assertRaises(ValidationError): AppSettingsSchema(theme='arbitrary-css')
        with self.assertRaises(ValidationError): AppSettingsSchema(theme_accent='url(evil)')
