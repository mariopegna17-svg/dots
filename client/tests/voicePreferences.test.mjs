import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_VOICE_PREFERENCES, loadVoicePreferences, normalizeVoicePreferences, saveVoicePreferences, takeSpeechSegments } from '../lib/voicePreferences.mjs';

test('preference loading tolerates blocked storage, malformed JSON and invalid values', () => {
  for (const value of ['{broken', 'null', '{}', '{"rate":99,"pauseMs":-1,"voiceURI":3}']) {
    assert.deepEqual(loadVoicePreferences({ getItem: () => value }), DEFAULT_VOICE_PREFERENCES);
  }
  assert.deepEqual(loadVoicePreferences({ getItem() { throw new Error('blocked'); } }), DEFAULT_VOICE_PREFERENCES);
  assert.doesNotThrow(() => saveVoicePreferences({ setItem() { throw new Error('blocked'); } }, DEFAULT_VOICE_PREFERENCES));
  assert.equal(normalizeVoicePreferences({ voiceURI: 'v'.repeat(999) }).voiceURI.length, 300);
});

test('valid saved choices survive controller recreation', () => {
  let saved;
  const storage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  const preferences = { voiceURI: 'Spanish', rate: 1.2, pauseMs: 1200 };
  saveVoicePreferences(storage, preferences);
  assert.deepEqual(loadVoicePreferences(storage), preferences);
});

test('stream parser waits for complete sentences, then consumes only new raw text', () => {
  assert.deepEqual(takeSpeechSegments('Hola.'), { cursor: 0, segments: [] });
  const first = takeSpeechSegments('Hola. La suma es 2.5 y sigue');
  assert.deepEqual(first.segments, ['Hola.']);
  const next = takeSpeechSegments('Hola. La suma es 2.5 y sigue igual. Otra', first.cursor);
  assert.deepEqual(next.segments, [' La suma es 2.5 y sigue igual.']);
  assert.deepEqual(takeSpeechSegments('Hola. La suma es 2.5 y sigue igual. Otra', next.cursor, true).segments, [' Otra']);
});

test('stream parser does not read partial Markdown links, code or paragraphs twice', () => {
  assert.equal(takeSpeechSegments('[Lee. aquí](https://example.com/a. b').segments.length, 0);
  assert.equal(takeSpeechSegments('```js\nconsole.log("Hola. ");\n').segments.length, 0);
  const text = '```js\nconsole.log("Hola. ");\n```\n\n[Fuente](https://example.com). Otra frase';
  const parsed = takeSpeechSegments(text);
  assert.equal(parsed.segments.length, 2);
  assert.equal(takeSpeechSegments(text, parsed.cursor).segments.length, 0);
});
