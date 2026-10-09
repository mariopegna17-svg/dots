import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandsFreeVoice, speechChunks, voiceText } from '../lib/handsFreeVoice.mjs';

function fixture({ submit = async () => true, unsupported = false } = {}) {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const recognizers = [];
  const spoken = [];
  const listeners = new Map();
  const states = [];
  const submissions = [];
  class Recognition {
    constructor() { recognizers.push(this); this.aborted = false; }
    start() { this.onstart?.(); }
    abort() { this.aborted = true; this.onend?.(); }
    final(text) { const result = [{ transcript: text }]; result.isFinal = true; this.onresult?.({ results: [result], resultIndex: 0 }); }
    interim(text) { const result = [{ transcript: text }]; result.isFinal = false; this.onresult?.({ results: [result], resultIndex: 0 }); }
    end() { this.onend?.(); }
    error(error) { this.onerror?.({ error }); }
  }
  class Utterance {
    constructor(text) { this.text = text; }
  }
  const browser = {
    SpeechRecognition: unsupported ? undefined : Recognition,
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: { cancel() {}, resume() {}, getVoices() { return [{ lang: 'es-ES' }]; }, speak(utterance) { spoken.push(utterance); } },
    document: {
      hidden: false,
      addEventListener(type, handler) { listeners.set(type, handler); },
      removeEventListener(type) { listeners.delete(type); },
    },
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const controller = createHandsFreeVoice({ browser, onState: state => states.push(state), onSubmit: async text => { submissions.push(text); return submit(text); } });
  function tick(ms) {
    const target = now + ms;
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = target;
  }
  return { controller, browser, timers, recognizers, spoken, states, submissions, listeners, tick };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('speaking a final phrase sends once after pause, stops microphone, reads completed reply and resumes', async () => {
  const f = fixture();
  f.controller.start();
  const recognition = f.recognizers.at(-1);
  recognition.final('Cuánto es dos más dos');
  f.tick(699);
  assert.equal(f.submissions.length, 0);
  f.tick(1);
  await settle();
  assert.deepEqual(f.submissions, ['Cuánto es dos más dos']);
  assert.equal(recognition.aborted, true);
  assert.equal(f.controller.getState().status, 'thinking');
  assert.equal(f.recognizers.length, 1);
  f.controller.update({ busy: true });
  f.controller.update({ busy: false, completedTurn: { id: 'reply-1', text: '**Dos más dos** son cuatro.', ok: true } });
  assert.equal(f.controller.getState().status, 'speaking');
  assert.equal(f.spoken.at(-1).text, 'Dos más dos son cuatro.');
  f.tick(1000);
  assert.equal(f.recognizers.length, 1, 'speaker output cannot be transcribed');
  f.spoken.at(-1).onend();
  f.tick(399);
  assert.equal(f.recognizers.length, 1);
  f.tick(1);
  assert.equal(f.recognizers.length, 2);
  assert.equal(f.controller.getState().status, 'listening');
  f.controller.destroy();
});

test('interim words are visible but never automatically sent', () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).interim('Un mensaje que sigue');
  f.tick(900);
  assert.equal(f.controller.getState().transcript, 'Un mensaje que sigue');
  assert.equal(f.submissions.length, 0);
  f.recognizers.at(-1).end();
  f.tick(400);
  assert.equal(f.recognizers.length, 2);
  assert.equal(f.submissions.length, 0);
  f.controller.destroy();
});

test('recognition onend submits finalized words immediately and does not send again at pause timer', async () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).final('Envíame un WhatsApp');
  f.recognizers.at(-1).end();
  f.tick(1000);
  await settle();
  assert.deepEqual(f.submissions, ['Envíame un WhatsApp']);
  f.controller.destroy();
});

test('manual Send now confirms the visible interim draft while automatic delivery still requires final words', async () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).interim('Envía esta frase visible');
  await f.controller.sendNow();
  assert.deepEqual(f.submissions, ['Envía esta frase visible']);
  assert.equal(f.recognizers.at(-1).aborted, true);
  assert.equal(f.controller.getState().status, 'thinking');
  f.controller.destroy();
});

test('approval pauses recognition, speaks no fabricated success and never resubmits the user request', async () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).final('Envíame cuatro por WhatsApp');
  f.tick(700);
  await settle();
  f.controller.update({ busy: true, approvalPending: true });
  assert.equal(f.controller.getState().status, 'approval');
  f.tick(120000);
  assert.equal(f.recognizers.length, 1);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.submissions.length, 1);
  f.controller.resume();
  assert.equal(f.controller.getState().status, 'approval');
  f.controller.update({ busy: false, approvalPending: false, completedTurn: { id: 'reply-2', text: 'WhatsApp ha aceptado el mensaje para su envío.', ok: true } });
  assert.equal(f.spoken.length, 1);
  assert.equal(f.controller.getState().status, 'speaking');
  f.controller.destroy();
});

test('failed completed turn stays paused and does not imply a sent message or retry transport', async () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).final('Envía un mensaje');
  f.tick(700);
  await settle();
  f.controller.update({ busy: false, completedTurn: { id: 'bad', text: 'No se ha enviado.', ok: false } });
  assert.equal(f.controller.getState().status, 'error');
  assert.equal(f.controller.getState().paused, true);
  assert.equal(f.spoken.length, 0);
  f.tick(100000);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.recognizers.length, 1);
  f.controller.destroy();
});

test('permission denial requires manual retry and stops listeners', () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).error('not-allowed');
  assert.match(f.controller.getState().error, /micrófono está bloqueado/);
  assert.equal(f.controller.getState().paused, true);
  f.tick(120000);
  assert.equal(f.recognizers.length, 1);
  f.controller.resume();
  assert.equal(f.recognizers.length, 2);
  f.controller.destroy();
});

test('network recognition failure does not send an interim or repeatedly reopen microphone', () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).interim('Un texto parcial');
  f.recognizers.at(-1).error('network');
  f.tick(120000);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.recognizers.length, 1);
  assert.match(f.controller.getState().error, /conexión/);
  f.controller.destroy();
});

test('silence and stalled recognition are recoverable without sending empty text', () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).error('no-speech');
  f.recognizers.at(-1).end();
  f.tick(400);
  assert.equal(f.recognizers.length, 2);
  f.tick(45400);
  assert.equal(f.recognizers.length, 3);
  assert.equal(f.submissions.length, 0);
  f.controller.destroy();
});

test('closing cancels all timers and stale callbacks, preserving the existing chat turn externally', async () => {
  const f = fixture();
  f.controller.start();
  const recognition = f.recognizers.at(-1);
  const staleResult = recognition.onresult;
  recognition.final('Mensaje que no envío');
  f.controller.stop();
  staleResult({ results: [[{ transcript: 'No se debe enviar' }]] });
  f.tick(100000);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.controller.getState().active, false);
  f.controller.start();
  f.recognizers.at(-1).final('Mensaje nuevo');
  f.tick(700);
  await settle();
  f.controller.destroy();
  f.controller.update({ busy: false, completedTurn: { id: 'late', text: 'No lo leas', ok: true } });
  assert.equal(f.spoken.length, 0);
  assert.equal(f.listeners.size, 0);
});

test('interrupting playback cancels its old callback before opening microphone', async () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).final('Dime algo');
  f.tick(700);
  await settle();
  f.controller.update({ completedTurn: { id: 'read', text: 'Una respuesta de prueba.', ok: true } });
  const staleEnd = f.spoken.at(-1).onend;
  f.controller.interrupt();
  staleEnd();
  f.tick(400);
  assert.equal(f.recognizers.length, 2);
  assert.equal(f.spoken.length, 1);
  f.controller.destroy();
});

test('changing tabs stops microphone and requires a gesture to return, with no speech in background', async () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).final('Consulta de voz');
  f.tick(700);
  await settle();
  f.browser.document.hidden = true;
  f.listeners.get('visibilitychange')();
  f.controller.update({ busy: false, completedTurn: { id: 'hidden', text: 'Respuesta guardada.', ok: true } });
  assert.equal(f.spoken.length, 0);
  f.browser.document.hidden = false;
  f.listeners.get('visibilitychange')();
  f.tick(10000);
  assert.equal(f.spoken.length, 0);
  assert.equal(f.controller.getState().status, 'paused');
  f.controller.resume();
  assert.equal(f.spoken.length, 1);
  f.controller.destroy();
});

test('rejected message and disconnected stream fail without automatic request repetition', async () => {
  for (const rejected of [false, true]) {
    const f = fixture({ submit: async () => rejected ? false : true });
    f.controller.start();
    f.recognizers.at(-1).final('No repitas esta acción');
    f.tick(700);
    await settle();
    if (!rejected) f.controller.update({ busy: false, streamError: 'connection lost' });
    assert.equal(f.controller.getState().status, 'error');
    f.tick(100000);
    assert.equal(f.submissions.length, 1);
    f.controller.destroy();
  }
});

test('a hung voice output has a bounded timeout and leaves the readable reply in the chat', async () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).final('Prueba');
  f.tick(700);
  await settle();
  f.controller.update({ completedTurn: { id: 'hung', text: 'Audio que no termina.', ok: true } });
  f.tick(12000);
  assert.equal(f.controller.getState().status, 'error');
  assert.match(f.controller.getState().error, /lectura de voz se ha detenido/);
  assert.equal(f.recognizers.length, 1);
  f.controller.destroy();
});

test('a hung response pauses voice without cancelling or resending an external action', async () => {
  const f = fixture();
  f.controller.start();
  f.recognizers.at(-1).final('Mensaje que espera respuesta');
  f.tick(700);
  await settle();
  f.controller.update({ busy: true });
  f.tick(75000);
  assert.equal(f.controller.getState().status, 'error');
  assert.match(f.controller.getState().error, /acción que ya autorizaste puede seguir/);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.recognizers.length, 1);
  f.controller.destroy();
});

test('unavailable browser gives explicit support instructions and can always close', () => {
  const f = fixture({ unsupported: true });
  assert.equal(f.controller.getState().supported, false);
  f.controller.start();
  assert.equal(f.controller.getState().active, true);
  assert.match(f.controller.getState().error, /iPhone.*Safari/);
  assert.equal(f.recognizers.length, 0);
  f.controller.stop();
  assert.equal(f.controller.getState().active, false);
  f.controller.destroy();
});

test('old history completion is not read without an actual voice request', () => {
  const f = fixture();
  f.controller.update({ completedTurn: { id: 'history', text: 'Historial anterior', ok: true } });
  f.controller.start();
  f.controller.update({ completedTurn: { id: 'history', text: 'Historial anterior', ok: true } });
  assert.equal(f.spoken.length, 0);
  f.controller.destroy();
});

test('readable voice text strips markup, keeps link labels and splits long responses', () => {
  assert.equal(voiceText('## Hola\n**Mundo** [resultado](https://example.test)\n```js\nsecret()\n```'), 'Hola Mundo resultado He dejado el código en el chat.');
  const chunks = speechChunks('Una frase corta. '.repeat(50));
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 220));
  assert.equal(chunks.join(' '), voiceText('Una frase corta. '.repeat(50)));
});
