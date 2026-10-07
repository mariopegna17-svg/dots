import asyncio
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import httpx

from app.main import app
from app.routers import connectors as router
from app.services.agent_service import run_agent
from app.services.action_gateway import ActionGateway, ActionGatewayError, action_gateway
from app.services.connected_tools import ConnectedTools, connected_tools, safe_result
from app.services.composio_service import ConnectorServiceError
from app.services.connector_service import ConnectorService
from app.services.storage_service import StorageService
from test_action_gateway import ImmediateApprovalBroker


def tool(slug, app, tags, properties=None, required=None):
    return {"slug": slug, "name": slug.replace('_', ' ').title(), "description": "Real provider action",
        "toolkit": {"slug": app}, "tags": tags, "version": "20261007_00", "is_deprecated": False,
        "input_parameters": {"type": "object", "properties": properties or {}, "required": required or [], "additionalProperties": False}}


class ConnectedToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.storage = StorageService(Path(self.temp.name))
        self.storage.save_settings({"composio_api_key": "fixture-private-key"})
        self.connections = ConnectorService(self.storage)
        self.service = ConnectedTools(self.connections)
        self.calls = []
        self.posts = []
        self.tools = {
            "GMAIL_FETCH_EMAILS": tool("GMAIL_FETCH_EMAILS", "gmail", ["readOnlyHint"], {"max_results": {"type": "integer", "minimum": 1, "maximum": 10}}, ["max_results"]),
            "GMAIL_SEND_EMAIL": tool("GMAIL_SEND_EMAIL", "gmail", ["createHint"], {key: {"type": "string"} for key in ("recipient_email", "subject", "body")}, ["recipient_email", "subject", "body"]),
            "GOOGLECALENDAR_LIST_EVENTS": tool("GOOGLECALENDAR_LIST_EVENTS", "googlecalendar", ["readOnlyHint"]),
            "NOTION_CREATE_PAGE": tool("NOTION_CREATE_PAGE", "notion", []),
            "SLACK_SEND_MESSAGE": tool("SLACK_SEND_MESSAGE", "slack", ["readOnlyHint", "createHint"]),
            "YOUTUBE_UPLOAD_VIDEO": tool("YOUTUBE_UPLOAD_VIDEO", "youtube", ["createHint"]),
        }
        self.account_id = "ca_owner"
        self.result = {"successful": True, "data": {"emails": [{"subject": "Reunión mañana", "body": "Nos vemos a las 10"}], "nextPageToken": "cursor-real", "access_token": "provider-secret"}}
        self.accounts = [{"id": self.account_id, "user_id": self.connections.user_id(), "status": "ACTIVE", "toolkit": {"slug": slug, "name": slug.title()}, "auth_config": {"id": "ac_" + slug}, "state": {"access_token": "never-expose"}} for slug in ("gmail", "googlecalendar", "notion", "slack", "youtube")]

        async def request(method, path, **kwargs):
            self.calls.append((method, path, copy.deepcopy(kwargs)))
            if path == "/connected_accounts":
                return {"items": self.accounts}
            if path == "/tools":
                toolkit = kwargs['params']['toolkit_slug']
                return {"items": [v for v in self.tools.values() if v['toolkit']['slug'] == toolkit], "next_cursor": "next-tools"}
            if path.startswith('/tools/execute/'):
                self.posts.append(copy.deepcopy(kwargs['json']))
                return self.result
            if path.startswith('/tools/'):
                return copy.deepcopy(self.tools.get(path.rsplit('/', 1)[-1], {}))
            raise AssertionError(path)
        self.connections.request = request
        self.gateway = ActionGateway(approvals=ImmediateApprovalBroker(), audit=self.storage)
        for name in ('connector.read', 'connector.change'):
            self.gateway.register_action(action_gateway.definitions[name], self.service.execute)

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_discovery_lists_all_owner_apps_without_credentials(self):
        self.accounts.append({'id': 'foreign', 'user_id': 'other-owner', 'status': 'ACTIVE', 'toolkit': {'slug': 'github'}})
        result = await self.service.apps()
        self.assertEqual({a['slug'] for a in result['apps']}, {'gmail', 'googlecalendar', 'notion', 'slack', 'youtube'})
        self.assertNotIn('never-expose', json.dumps(result))
        params = self.calls[0][2]['params']
        self.assertEqual(params['user_ids'], [self.connections.user_id()])
        self.assertNotIn('toolkit_slugs', params)

    async def test_search_returns_real_schema_and_pagination_for_connected_app(self):
        result = await self.service.search('gmail', 'fetch emails', 'page-two')
        self.assertEqual(result['next_cursor'], 'next-tools')
        read = next(t for t in result['actions'] if t['action'] == 'GMAIL_FETCH_EMAILS')
        self.assertIn('max_results', read['parameters']['properties'])
        self.assertFalse(read['requires_approval'])
        self.assertEqual(self.calls[-1][2]['params'], {'toolkit_slug': 'gmail', 'limit': 6, 'include_deprecated': False, 'toolkit_versions': 'latest', 'search': 'fetch emails', 'cursor': 'page-two', 'auth_config_ids': 'ac_gmail'})

    async def test_gmail_read_executes_real_bound_account_and_hides_credentials(self):
        invocation = await self.service.prepare('gmail', 'GMAIL_FETCH_EMAILS', {'max_results': 5})
        self.assertEqual(self.calls[-1], ('GET', '/tools/GMAIL_FETCH_EMAILS', {'params': {'version': 'latest'}}))
        request, approval = self.gateway.open('thread', 'bot', invocation)
        self.assertIsNone(approval)
        self.assertEqual(await self.gateway.wait_for_decision(request), 'allow')
        result = await self.gateway.execute(request)
        self.assertEqual(result.status, 'completed')
        self.assertEqual(result.result['data']['emails'][0]['subject'], 'Reunión mañana')
        self.assertEqual(result.result['data']['nextPageToken'], 'cursor-real')
        self.assertNotIn('provider-secret', json.dumps(result.result))
        self.assertEqual(self.posts[0], {'connected_account_id': self.account_id, 'user_id': self.connections.user_id(), 'version': '20261007_00', 'arguments': {'max_results': 5}})

    async def test_send_waits_for_review_and_cannot_execute_twice(self):
        data = {'recipient_email': 'fixture@example.test', 'subject': 'Reunión', 'body': 'Contenido revisable'}
        invocation = await self.service.prepare('gmail', 'GMAIL_SEND_EMAIL', data)
        request, approval = self.gateway.open('thread', 'bot', invocation)
        self.assertTrue(request.requires_approval)
        self.assertIn('Contenido revisable', json.dumps(approval['arguments']))
        self.assertNotIn('key_fingerprint', json.dumps(approval))
        with self.assertRaises(ActionGatewayError): await self.gateway.execute(request)
        self.assertEqual(self.posts, [])
        await self.gateway.wait_for_decision(request)
        self.assertEqual((await self.gateway.execute(request)).status, 'completed')
        with self.assertRaises(ActionGatewayError): await self.gateway.execute(request)
        self.assertEqual(len(self.posts), 1)

    async def test_denied_send_never_calls_provider(self):
        self.gateway.approvals = ImmediateApprovalBroker('deny')
        invocation = await self.service.prepare('gmail', 'GMAIL_SEND_EMAIL', {'recipient_email': 'fixture@example.test', 'subject': 'x', 'body': 'x'})
        request, _ = self.gateway.open('thread', 'bot', invocation)
        self.assertEqual(await self.gateway.wait_for_decision(request), 'deny')
        with self.assertRaises(ActionGatewayError): await self.gateway.execute(request)
        self.assertFalse(self.posts)

    async def test_missing_wrong_type_nested_and_unknown_parameters_do_not_dispatch(self):
        for data in ({}, {'max_results': 'five'}, {'max_results': 100}, {'max_results': 5, 'connected_account_id': 'foreign'}):
            with self.subTest(data=data), self.assertRaises(ConnectorServiceError):
                await self.service.prepare('gmail', 'GMAIL_FETCH_EMAILS', data)
        self.assertFalse(self.posts)

    async def test_foreign_toolkit_unknown_and_path_injection_cannot_dispatch(self):
        for action in ('GOOGLECALENDAR_LIST_EVENTS', 'UNKNOWN_TOOL', '../proxy'):
            with self.subTest(action=action), self.assertRaises(ConnectorServiceError):
                await self.service.prepare('gmail', action, {})
        self.assertFalse(self.posts)

    async def test_disconnected_expired_and_ambiguous_accounts_are_actionable(self):
        self.accounts[0]['status'] = 'EXPIRED'
        with self.assertRaisesRegex(ConnectorServiceError, 'renueva'): await self.service.search('gmail')
        self.accounts[0]['status'] = 'ACTIVE'
        self.accounts.append({**self.accounts[0], 'id': 'second'})
        with self.assertRaisesRegex(ConnectorServiceError, 'varias cuentas'): await self.service.search('gmail')
        self.assertFalse(self.posts)

    async def test_account_and_key_changes_after_review_cannot_dispatch(self):
        for change in ('account', 'key'):
            invocation = await self.service.prepare('gmail', 'GMAIL_SEND_EMAIL', {'recipient_email': 'fixture@example.test', 'subject': 'x', 'body': 'x'})
            request, _ = self.gateway.open('thread', 'bot', invocation)
            await self.gateway.wait_for_decision(request)
            if change == 'account': self.accounts[0]['id'] = 'new-account'
            else: self.storage.save_settings({'composio_api_key': 'new-fixture-key'})
            outcome = await self.gateway.execute(request)
            self.assertEqual(outcome.status, 'failed')
            self.assertIn('han cambiado', outcome.error)
        self.assertFalse(self.posts)

    async def test_other_apps_use_same_executor_and_uncertain_tags_need_approval(self):
        for app, action, read in [('googlecalendar', 'GOOGLECALENDAR_LIST_EVENTS', True), ('notion', 'NOTION_CREATE_PAGE', False), ('slack', 'SLACK_SEND_MESSAGE', False)]:
            invocation = await self.service.prepare(app, action, {})
            request, _ = self.gateway.open('thread', 'bot', invocation)
            self.assertEqual(request.requires_approval, not read)
            await self.gateway.wait_for_decision(request)
            self.assertEqual((await self.gateway.execute(request)).status, 'completed')

    async def test_youtube_upload_keeps_reviewed_video_flow(self):
        with self.assertRaisesRegex(ConnectorServiceError, 'borrador'):
            await self.service.prepare('youtube', 'YOUTUBE_UPLOAD_VIDEO', {})
        self.assertFalse(self.posts)

    async def test_provider_errors_are_explained_without_raw_secrets(self):
        self.result = {'successful': False, 'error': '403 insufficient scopes secret=provider-private'}
        invocation = await self.service.prepare('gmail', 'GMAIL_FETCH_EMAILS', {'max_results': 5})
        request, _ = self.gateway.open('thread', 'bot', invocation)
        result = await self.gateway.execute(request)
        self.assertEqual(result.status, 'failed')
        self.assertIn('falta permiso', result.error)
        self.assertNotIn('provider-private', result.error)

    async def test_external_schema_refs_are_rejected_without_network_fetch(self):
        for ref in ('$ref', '$dynamicRef', '$recursiveRef'):
            self.tools['GMAIL_FETCH_EMAILS']['input_parameters'] = {ref: 'https://other.example.test/schema'}
            with self.subTest(ref=ref), self.assertRaisesRegex(ConnectorServiceError, 'referencia externa'):
                await self.service.prepare('gmail', 'GMAIL_FETCH_EMAILS', {})

    async def test_owner_routes_hide_account_state_and_reject_anonymous(self):
        transport = httpx.ASGITransport(app=app)
        with patch.object(router, 'connected_tools', self.service), patch('app.main.auth_service.authenticate_request', return_value=None):
            async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
                for path in ('/api/v1/connectors/apps', '/api/v1/connectors/gmail/actions'):
                    self.assertEqual((await client.get(path)).status_code, 401)
        with patch.object(router, 'connected_tools', self.service), patch('app.main.auth_service.authenticate_request', return_value={'id': 'local-user'}):
            async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
                response = await client.get('/api/v1/connectors/gmail/actions?query=fetch%20emails')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers['cache-control'], 'no-store')
                self.assertNotIn('never-expose', response.text)

    async def test_agent_uses_gmail_results_and_receives_dynamic_tools(self):
        calls = []
        steps = [('connector_list_apps', {}), ('connector_search_actions', {'app': 'gmail', 'query': 'fetch emails'}),
                 ('connector_execute', {'app': 'gmail', 'action': 'GMAIL_FETCH_EMAILS', 'parameters': {'max_results': 5}})]
        async def provider(**kwargs):
            calls.append(copy.deepcopy(kwargs))
            index = len(calls) - 1
            if index < len(steps):
                name, arguments = steps[index]
                yield {'type': 'tool.call', 'calls': [{'id': 'call-' + str(index), 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(arguments)}}]}
            else:
                self.assertIn('Reunión mañana', kwargs['messages'][-1]['content'])
                yield {'type': 'content.delta', 'delta': 'Tienes un correo sobre la reunión de mañana.'}
                yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.connected_tools', self.service), patch('app.services.agent_service.action_gateway', self.gateway), patch('app.services.agent_service.provider_service.stream_chat_completion', provider), patch('app.services.agent_service.storage_service.get_settings', return_value={'model_api_wire_api': 'chat_completions'}), patch('app.services.agent_service.memory_service.context', return_value=''):
            events = [event async for event in run_agent('bot', 'fixture-model', [{'role': 'user', 'content': 'Resume mis últimos 5 correos de Gmail'}], 'Ayuda al usuario.')]
        self.assertEqual(events[-1], {'type': 'turn.completed', 'ok': True})
        self.assertEqual(len(self.posts), 1)
        self.assertTrue({'connector_list_apps', 'connector_search_actions', 'connector_execute'} <= {t['function']['name'] for t in calls[0]['tools']})
        self.assertFalse(any(e['type'] == 'request.opened' for e in events))

    async def test_background_agent_never_gets_private_connector_tools(self):
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            yield {'type': 'content.delta', 'delta': 'Análisis'}
            yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.agent_service.connected_tools', self.service), patch('app.services.agent_service.provider_service.stream_chat_completion', provider), patch('app.services.agent_service.storage_service.get_settings', return_value={'model_api_wire_api': 'chat_completions'}), patch('app.services.agent_service.memory_service.context', return_value=''):
            [e async for e in run_agent('bot', 'fixture-model', [{'role': 'user', 'content': 'Analiza'}], '', background=True)]
        self.assertEqual([t['function']['name'] for t in captured[0]['tools']], ['search_web'])

    async def test_agent_returns_connector_error_instead_of_generic_failure(self):
        turns = []
        async def provider(**kwargs):
            turns.append(kwargs)
            if len(turns) == 1:
                yield {'type': 'tool.call', 'calls': [{'id': 'fixture-error', 'type': 'function', 'function': {'name': 'connector_search_actions', 'arguments': json.dumps({'app': 'gmail', 'query': 'fetch emails'})}}]}
            else:
                self.assertIn('renueva', kwargs['messages'][-1]['content'])
                yield {'type': 'content.delta', 'delta': 'Renueva la autorización de Gmail.'}
                yield {'type': 'turn.completed', 'ok': True}
        self.accounts[0]['status'] = 'EXPIRED'
        with patch('app.services.agent_service.connected_tools', self.service), patch('app.services.agent_service.provider_service.stream_chat_completion', provider), patch('app.services.agent_service.storage_service.get_settings', return_value={'model_api_wire_api': 'chat_completions'}), patch('app.services.agent_service.memory_service.context', return_value=''):
            events = [event async for event in run_agent('bot', 'fixture-model', [{'role': 'user', 'content': 'Lee Gmail'}], '')]
        failed = next(e for e in events if e['type'] == 'tool.failed')
        self.assertIn('renueva', failed['error'])
        self.assertFalse(self.posts)

    def test_results_are_bounded_and_pagination_survives_redaction(self):
        result = safe_result({'emails': ['x' * 12000] * 100, 'next_page_token': 'usable', 'refresh_token': 'secret'})
        self.assertLess(len(result['emails']), 50)
        self.assertLess(len(result['emails'][0]), 11000)
        self.assertEqual(result['next_page_token'], 'usable')
        self.assertEqual(result['refresh_token'], '[REDACTED]')


if __name__ == '__main__':
    unittest.main()
