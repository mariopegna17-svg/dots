import asyncio
import io
import hashlib
import json
import math
import struct
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

from app.services.storage_service import StorageService
from app.services.communication_service import CommunicationService, CommunicationError
from app.services.whatsapp_qr_service import WhatsAppQRService, WhatsAppQRSettings
from app.services.whatsapp_media import WhatsAppMediaService, prepare_image, decode_audio, ASR_FUNCTION


def wav(seconds=1):
    output = io.BytesIO()
    with wave.open(output, 'wb') as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(16000)
        file.writeframes(b''.join(struct.pack('<h', int(1000 * math.sin(i * 440 * 2 * math.pi / 16000))) for i in range(16000 * seconds)))
    return output.getvalue()


class MediaTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.storage = StorageService(Path(self.directory.name))
        self.storage.save_settings({'model_api_key': 'test-nvidia-key', 'model_api_wire_api': 'chat_completions', 'model_api_base_url': 'https://integrate.api.nvidia.com/v1'})
        self.media = WhatsAppMediaService(self.storage)
        self.communications = CommunicationService(self.storage)
        self.service = WhatsAppQRService(self.storage, self.communications)
        self.bot = self.storage.get_bots()[0]['id']
        self.storage.save_settings({'whatsapp_qr_enabled': True, 'whatsapp_qr_bot_id': self.bot})
        self.service.available = True
        self.service.request = AsyncMock(return_value={'id': 'fake-reply', 'status': 'sent'})
        self.event = {'id': 'media-fixture', 'peer': 'owner@s.whatsapp.net', 'text': ''}

    def test_image_reencoding_removes_metadata_and_bounds_inline_payload(self):
        original = Image.new('RGB', (1800, 1400), 'blue')
        exif = Image.Exif()
        exif[270] = 'private-photo-description'
        output = io.BytesIO()
        original.save(output, format='JPEG', exif=exif)
        encoded = prepare_image(output.getvalue())
        import base64
        decoded = base64.b64decode(encoded.split(',', 1)[1])
        self.assertNotIn(b'private-photo-description', decoded)
        self.assertLess(len(encoded), 180000)
        with Image.open(io.BytesIO(decoded)) as small:
            self.assertLessEqual(max(small.size), 768)
            self.assertFalse(small.getexif())

    async def test_photo_uses_real_vision_api_contract_and_caption(self):
        picture = io.BytesIO()
        Image.new('RGB', (16, 16), 'red').save(picture, format='PNG')
        captured = []
        async def handler(request):
            captured.append(request)
            return httpx.Response(200, json={'choices': [{'message': {'content': 'Un cuadrado rojo.'}}]})
        original_client = httpx.AsyncClient
        with patch('app.services.whatsapp_media.httpx.AsyncClient', lambda **kwargs: original_client(transport=httpx.MockTransport(handler), **kwargs)):
            text = await self.media.understand({'kind': 'image'}, picture.getvalue(), '¿De qué color es?')
        request = captured[0]
        body = json.loads(request.content)
        self.assertEqual(request.url.host, 'integrate.api.nvidia.com')
        self.assertEqual(request.headers['Authorization'], 'Bearer test-nvidia-key')
        self.assertEqual(body['model'], 'meta/llama-3.2-11b-vision-instruct')
        self.assertTrue(body['stream'])
        self.assertLessEqual(body['max_tokens'], 384)
        self.assertIn('¿De qué color es?', body['messages'][0]['content'][0]['text'])
        self.assertTrue(body['messages'][0]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,'))
        self.assertIn('Un cuadrado rojo.', text)
        self.assertIn('¿De qué color es?', text)
        self.assertNotIn('base64', text)

    async def test_vision_reads_nvidia_stream_and_requires_a_complete_real_description(self):
        picture = io.BytesIO()
        Image.new('RGB', (32, 32), 'blue').save(picture, format='PNG')
        events = [
            {'choices': [{'delta': {'content': 'Una figura '}, 'finish_reason': None}]},
            {'choices': [{'delta': {'content': 'azul.'}, 'finish_reason': 'stop'}]},
        ]
        captured = []
        async def handler(request):
            captured.append(request)
            return httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, text=''.join('data: ' + json.dumps(event) + '\n\n' for event in events) + 'data: [DONE]\n\n')
        original = httpx.AsyncClient
        with patch('app.services.whatsapp_media.httpx.AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs)):
            result = await self.media.understand({'kind': 'image'}, picture.getvalue(), 'Describe la figura')
        self.assertIn('Una figura azul.', result)
        self.assertEqual(len(captured), 1)

    async def test_vision_timeout_retries_a_smaller_photo_once_without_blame_or_secrets(self):
        import base64
        picture = io.BytesIO()
        Image.new('RGB', (1200, 900), 'green').save(picture, format='PNG')
        sizes = []
        async def handler(request):
            payload = json.loads(request.content)
            image = payload['messages'][0]['content'][1]['image_url']['url'].split(',', 1)[1]
            with Image.open(io.BytesIO(base64.b64decode(image))) as encoded:
                sizes.append(encoded.size)
            if len(sizes) == 1:
                raise httpx.ReadTimeout('nvapi-secret must stay private', request=request)
            return httpx.Response(200, json={'choices': [{'message': {'content': 'La foto es verde.'}}]})
        original = httpx.AsyncClient
        with patch('app.services.whatsapp_media.httpx.AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs)):
            result = await self.media.understand({'kind': 'image'}, picture.getvalue())
        self.assertIn('verde', result)
        self.assertEqual(len(sizes), 2)
        self.assertLess(max(sizes[1]), max(sizes[0]))

    async def test_vision_auth_and_quota_fail_fast_and_report_the_actual_failure(self):
        picture = io.BytesIO()
        Image.new('RGB', (16, 16), 'red').save(picture, format='PNG')
        original = httpx.AsyncClient
        for status, diagnostic in [(401, 'rechazado la clave'), (403, 'no tiene acceso'), (404, 'no está disponible'), (429, 'límite')]:
            calls = []
            async def handler(request):
                calls.append(request)
                return httpx.Response(status, json={'error': 'nvapi-secret-debug'})
            with patch('app.services.whatsapp_media.httpx.AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs)):
                with self.assertRaisesRegex(CommunicationError, diagnostic) as caught:
                    await self.media.understand({'kind': 'image'}, picture.getvalue())
            self.assertEqual(len(calls), 1)
            self.assertNotIn('secret', str(caught.exception))

    async def test_vision_stalled_and_truncated_streams_never_claim_to_have_seen_the_photo(self):
        picture = io.BytesIO()
        Image.new('RGB', (16, 16), 'red').save(picture, format='PNG')
        original = httpx.AsyncClient
        for timeout in [True, False]:
            calls = []
            async def handler(request):
                calls.append(request)
                if timeout: raise httpx.ReadTimeout('private-upstream-details', request=request)
                return httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, text='data: {"choices":[{"delta":{"content":"Un fragmento"}}]}\n\n')
            with patch('app.services.whatsapp_media.httpx.AsyncClient', lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs)):
                with self.assertRaises(CommunicationError) as caught:
                    await self.media.understand({'kind': 'image'}, picture.getvalue())
            self.assertEqual(len(calls), 2)
            self.assertNotIn('private', str(caught.exception))
            self.assertNotIn('clave', str(caught.exception))

    async def test_photo_observations_reach_selected_dot_and_one_reply_is_sent(self):
        event = {**self.event, 'media': {'kind': 'image', 'mime': 'image/jpeg', 'size': 6}, 'text': '¿Qué color ves?'}
        async def provider(**kwargs):
            self.assertIn('foto de este mensaje ya se ha analizado', kwargs['system_prompt'])
            self.assertIn('círculo azul', kwargs['messages'][-1]['content'])
            yield {'type': 'content.delta', 'delta': 'Es un círculo azul.'}
            yield {'type': 'turn.completed', 'ok': True}
        with patch.object(self.service, 'download_media', AsyncMock(return_value=b'binary')), patch.object(self.service.media, 'understand', AsyncMock(return_value='[Foto recibida] Un círculo azul.')), patch('app.services.communication_service.provider_service.stream_chat_completion', provider):
            await self.service.handle(event)
            await self.service.handle(event)
        replies = [call for call in self.service.request.await_args_list if call.args[1] == '/reply']
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0].args[2]['text'], 'Es un círculo azul.')

    async def test_audio_conversion_really_decodes_wav_to_mono_16khz_pcm(self):
        pcm = await decode_audio(wav())
        self.assertEqual(len(pcm), 32000)
        self.assertNotEqual(pcm[:4], b'RIFF')
        with self.assertRaisesRegex(CommunicationError, 'abrir este audio'):
            await decode_audio(b'not an audio')

    async def test_bundled_ffmpeg_decodes_audio_without_system_installation(self):
        with patch('app.services.whatsapp_media.shutil.which', return_value=None):
            pcm = await decode_audio(wav())
        self.assertEqual(len(pcm), 32000)

    async def test_whatsapp_ogg_opus_voice_note_is_decoded_by_the_bundled_reader(self):
        import imageio_ffmpeg
        process = await asyncio.create_subprocess_exec(imageio_ffmpeg.get_ffmpeg_exe(), '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1', stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        ogg, _ = await process.communicate(wav())
        self.assertEqual(process.returncode, 0)
        self.assertTrue(ogg.startswith(b'OggS'))
        with patch('app.services.whatsapp_media.shutil.which', return_value=None):
            pcm = await decode_audio(ogg)
        self.assertGreaterEqual(len(pcm), 30000)
        self.assertLessEqual(len(pcm), 33000)

    async def test_transcription_uses_spanish_authenticated_whisper_riva_and_real_transcript(self):
        captured = []
        class Channel:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        async def recognize(request, **kwargs):
            captured.append((request, kwargs))
            return SimpleNamespace(results=[SimpleNamespace(alternatives=[SimpleNamespace(transcript='Busca en Internet el tiempo en Madrid.')])])
        with patch('grpc.aio.secure_channel', return_value=Channel()), patch('riva.client.proto.riva_asr_pb2_grpc.RivaSpeechRecognitionStub', return_value=SimpleNamespace(Recognize=recognize)):
            text = await self.media.understand({'kind': 'audio'}, wav())
        self.assertEqual(text, 'Busca en Internet el tiempo en Madrid.')
        request, kwargs = captured[0]
        self.assertEqual(request.config.language_code, 'es')
        self.assertEqual(request.config.sample_rate_hertz, 16000)
        self.assertEqual(len(request.audio), 32000)
        self.assertEqual(dict(kwargs['metadata'])['function-id'], ASR_FUNCTION)
        self.assertEqual(dict(kwargs['metadata'])['authorization'], 'Bearer test-nvidia-key')
        self.assertLessEqual(kwargs['timeout'], 40)

    async def test_media_failure_is_sanitized_and_wrong_provider_key_is_not_sent_to_nvidia(self):
        with patch.object(self.media, 'transcribe', side_effect=RuntimeError('nvapi-secret-debug')):
            with self.assertRaisesRegex(CommunicationError, 'transcribir') as caught:
                await self.media.understand({'kind': 'audio'}, b'bytes')
        self.assertNotIn('secret', str(caught.exception))
        self.storage.save_settings({'model_api_base_url': 'https://another-provider.example/v1'})
        with patch.dict('os.environ', {'NVIDIA_API_KEY': ''}):
            with self.assertRaisesRegex(CommunicationError, 'clave de NVIDIA'):
                self.media.key()

    async def test_asr_network_failure_explains_connectivity_without_exposing_upstream_details(self):
        import grpc
        class Channel:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
        failure = grpc.aio.AioRpcError(grpc.StatusCode.UNAVAILABLE, None, None, 'HTTP proxy denied; nvapi-secret')
        with patch('grpc.aio.secure_channel', return_value=Channel()), patch('riva.client.proto.riva_asr_pb2_grpc.RivaSpeechRecognitionStub', return_value=SimpleNamespace(Recognize=AsyncMock(side_effect=failure))):
            with self.assertRaisesRegex(CommunicationError, 'grpc.nvcf.nvidia.com') as caught:
                await self.media.understand({'kind': 'audio'}, wav())
        self.assertNotIn('secret', str(caught.exception))

    async def test_media_understanding_reaches_dot_once_and_only_text_enters_history(self):
        event = {**self.event, 'media': {'kind': 'audio', 'mime': 'audio/ogg', 'size': 6}}
        async def provider(**kwargs):
            self.assertIn('Cuánto es dos más dos', kwargs['messages'][-1]['content'])
            yield {'type': 'content.delta', 'delta': 'Dos más dos son cuatro.'}
            yield {'type': 'turn.completed', 'ok': True}
        with patch.object(self.service, 'download_media', AsyncMock(return_value=b'binary')) as download, patch.object(self.service.media, 'understand', AsyncMock(return_value='Cuánto es dos más dos')) as understand, patch('app.services.communication_service.provider_service.stream_chat_completion', provider):
            await self.service.handle(event)
            await self.service.handle(event)
        download.assert_awaited_once_with(event['id'])
        understand.assert_awaited_once_with(event['media'], b'binary', '')
        self.assertEqual(len([c for c in self.service.request.await_args_list if c.args[1] == '/reply']), 1)
        thread = next(iter(self.communications.recent()))
        self.assertEqual(thread['message'], 'Cuánto es dos más dos')
        self.assertEqual(thread['status'], 'sent')
        peer_hash = hashlib.sha256(self.event['peer'].encode()).hexdigest()[:16]
        messages = self.storage.get_messages('whatsapp-qr-' + self.bot + '-' + peer_hash)
        self.assertEqual([message['text'] for message in messages], ['Cuánto es dos más dos', 'Dos más dos son cuatro.'])

    async def test_media_failure_replies_once_and_does_not_disable_connection(self):
        event = {**self.event, 'media_error': 'El audio es demasiado largo. Envía notas de voz de hasta dos minutos.'}
        with patch.object(self.communications, 'answer', AsyncMock()) as answer:
            await self.service.handle(event)
            await self.service.handle(event)
        answer.assert_not_awaited()
        replies = [c for c in self.service.request.await_args_list if c.args[1] == '/reply']
        self.assertEqual(len(replies), 1)
        self.assertIn('dos minutos', replies[0].args[2]['text'])
        self.assertTrue(self.service.config()['enabled'])

    async def test_media_disconnect_and_uncertain_send_never_trigger_another_reply(self):
        event = {**self.event, 'media': {'kind': 'image', 'size': 6}}
        async def change_config(*args):
            self.storage.save_settings({'whatsapp_qr_enabled': False})
            return 'Una foto'
        with patch.object(self.service, 'download_media', AsyncMock(return_value=b'binary')), patch.object(self.service.media, 'understand', side_effect=change_config), patch.object(self.communications, 'answer', AsyncMock()) as answer:
            await self.service.handle(event)
        answer.assert_not_awaited()
        self.assertFalse(any(c.args[1] == '/reply' for c in self.service.request.await_args_list))
        self.storage.save_settings({'whatsapp_qr_enabled': True})
        async def bridge(method, path, data=None):
            if path == '/reply': raise CommunicationError('Resultado desconocido')
            return {'ok': True}
        self.service.request.reset_mock()
        self.service.request.side_effect = bridge
        with patch.object(self.service, 'download_media', AsyncMock(return_value=b'binary')), patch.object(self.service.media, 'understand', AsyncMock(return_value='Una foto')), patch.object(self.communications, 'answer', AsyncMock(return_value='Descripción')):
            await self.service.handle({**event, 'id': 'new-photo'})
        self.assertEqual(len([c for c in self.service.request.await_args_list if c.args[1] == '/reply']), 1)

    async def test_search_is_read_only_uses_results_and_cites_source_in_whatsapp(self):
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            if len(captured) == 1:
                yield {'type': 'tool.call', 'calls': [{'id': 'search-call', 'type': 'function', 'function': {'name': 'search_web', 'arguments': '{"query":"tiempo Madrid"}'}}]}
            else:
                self.assertEqual(kwargs['messages'][-1]['role'], 'tool')
                self.assertIn('18 grados', kwargs['messages'][-1]['content'])
                yield {'type': 'content.delta', 'delta': 'En Madrid hay 18 grados según la fuente consultada.'}
                yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.communication_service.provider_service.stream_chat_completion', provider), patch('app.services.communication_service.youcom_service.search_web', AsyncMock(return_value={'results': [{'url': 'https://weather.example/madrid', 'snippet': '18 grados'}]})) as search:
            reply = await self.communications.answer(self.bot, 'Busca en Internet el tiempo en Madrid', 'search-thread')
        search.assert_awaited_once_with('tiempo Madrid', count=3)
        self.assertIn('https://weather.example/madrid', reply)
        self.assertEqual([t['function']['name'] for t in captured[0]['tools']], ['search_web'])
        self.assertEqual(captured[0]['tool_choice'], {'type': 'function', 'function': {'name': 'search_web'}})

    async def test_search_failures_and_unsupported_tools_do_not_invent_or_execute_actions(self):
        captured = []
        async def provider(**kwargs):
            captured.append(kwargs)
            if len(captured) == 1:
                yield {'type': 'tool.call', 'calls': [{'id': '1', 'function': {'name': 'search_web', 'arguments': '{"query":"noticias"}'}}, {'id': '2', 'function': {'name': 'whatsapp_owner', 'arguments': '{"message":"unsafe"}'}}]}
            else:
                self.assertIn('no está disponible', kwargs['messages'][-2]['content'])
                self.assertIn('solo permite buscar', kwargs['messages'][-1]['content'])
                yield {'type': 'content.delta', 'delta': 'Ahora no puedo consultar las noticias.'}
                yield {'type': 'turn.completed', 'ok': True}
        with patch('app.services.communication_service.provider_service.stream_chat_completion', provider), patch('app.services.communication_service.youcom_service.search_web', AsyncMock(side_effect=RuntimeError('private key'))):
            reply = await self.communications.answer(self.bot, 'Busca noticias', 'failed-search')
        self.assertNotIn('private key', str(captured))
        self.assertNotIn('Fuente:', reply)

    async def test_audio_longer_than_two_minutes_is_rejected_after_decoding(self):
        output = io.BytesIO()
        with wave.open(output, 'wb') as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b'\0' * 16000 * 2 * 122)
        with self.assertRaisesRegex(CommunicationError, 'dos minutos'):
            await decode_audio(output.getvalue())

    async def test_missing_or_oversize_bridge_attachments_are_rejected(self):
        async def handler(request):
            self.assertEqual(request.url.path, '/media/message-id')
            return httpx.Response(200, content=b'x' * (8 * 1024 * 1024 + 1))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url='http://127.0.0.1:8787') as client:
            self.service.client = client
            with self.assertRaisesRegex(CommunicationError, 'supera el límite'):
                await self.service.download_media('message-id')
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(404)), base_url='http://127.0.0.1:8787') as client:
            self.service.client = client
            with self.assertRaisesRegex(CommunicationError, 'ya no está disponible'):
                await self.service.download_media('message-id')


if __name__ == '__main__':
    unittest.main()
