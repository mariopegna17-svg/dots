import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandsFreeVoice, speechChunks, voiceText, VOICE_GREETING } from '../lib/handsFreeVoice.mjs';

function fixture({ submit = async () => true, unsupported = false, autoGreeting = true, voices = [{ lang: 'es-ES' }] } = {}) {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  const recognizers = [];
  const spoken = [];
  const playbacks = [];
  const voiceListeners = new Map();
  const listeners = new Map();
  const events = new Map();
  const saved = new Map();
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
    navigator: { onLine: true },
    localStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) },
    addEventListener(type, handler) { events.set(type, handler); },
    removeEventListener(type) { events.delete(type); },
    SpeechRecognition: unsupported ? undefined : Recognition,
    SpeechSynthesisUtterance: Utterance,
    speechSynthesis: {
      cancel() {}, resume() {},
      getVoices() { return voices; },
      addEventListener(type, handler) { voiceListeners.set(type, handler); },
      removeEventListener(type) { voiceListeners.delete(type); },
      speak(utterance) {
        playbacks.push(utterance);
        const greeting = [VOICE_GREETING, 'Te escucho.'].includes(utterance.text);
        if (!greeting) spoken.push(utterance);
        utterance.onstart?.();
        if (greeting && autoGreeting) utterance.onend?.();
      },
    },
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
  function start() { controller.start(); if (autoGreeting) tick(400); }
  function setVoices(next) { voices = next; voiceListeners.get('voiceschanged')?.(); }
  return { controller, browser, timers, recognizers, spoken, playbacks, states, submissions, listeners, events, saved, voiceListeners, tick, start, setVoices };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('speaking a final phrase sends once after pause, stops microphone, reads completed reply and resumes', async () => {
  const f = fixture();
  f.start();
  const recognition = f.recognizers.at(-1);
  recognition.final('Cuánto es dos más dos');
  f.tick(849);
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
  f.start();
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
  f.start();
  f.recognizers.at(-1).final('Envíame un WhatsApp');
  f.recognizers.at(-1).end();
  f.tick(1000);
  await settle();
  assert.deepEqual(f.submissions, ['Envíame un WhatsApp']);
  f.controller.destroy();
});

test('manual Send now confirms the visible interim draft while automatic delivery still requires final words', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).interim('Envía esta frase visible');
  await f.controller.sendNow();
  assert.deepEqual(f.submissions, ['Envía esta frase visible']);
  assert.equal(f.recognizers.at(-1).aborted, true);
  assert.equal(f.controller.getState().status, 'thinking');
  f.controller.destroy();
});

test('approval pauses recognition, speaks no fabricated success and never resubmits the user request', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).final('Envíame cuatro por WhatsApp');
  f.tick(850);
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
  f.start();
  f.recognizers.at(-1).final('Envía un mensaje');
  f.tick(850);
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
  f.start();
  f.recognizers.at(-1).error('not-allowed');
  assert.match(f.controller.getState().error, /micrófono está bloqueado/);
  assert.equal(f.controller.getState().paused, true);
  f.tick(120000);
  assert.equal(f.recognizers.length, 1);
  f.controller.resume();
  f.tick(400);
  assert.equal(f.recognizers.length, 2);
  f.controller.destroy();
});

test('network recognition failure retries with bounded backoff without sending an interim', () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).interim('Un texto parcial');
  f.recognizers.at(-1).error('network');
  assert.equal(f.controller.getState().status, 'recovering');
  for (const delay of [700, 1500, 3000]) {
    f.tick(delay);
    f.recognizers.at(-1).error('network');
  }
  f.tick(120000);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.recognizers.length, 4);
  assert.match(f.controller.getState().error, /conexión/);
  f.controller.destroy();
});

test('silence and stalled recognition are recoverable without sending empty text', () => {
  const f = fixture();
  f.start();
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
  f.start();
  const recognition = f.recognizers.at(-1);
  const staleResult = recognition.onresult;
  recognition.final('Mensaje que no envío');
  f.controller.stop();
  staleResult({ results: [[{ transcript: 'No se debe enviar' }]] });
  f.tick(100000);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.controller.getState().active, false);
  f.start();
  f.recognizers.at(-1).final('Mensaje nuevo');
  f.tick(850);
  await settle();
  f.controller.destroy();
  f.controller.update({ busy: false, completedTurn: { id: 'late', text: 'No lo leas', ok: true } });
  assert.equal(f.spoken.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.voiceListeners.size, 0);
});

test('interrupting playback cancels its old callback before opening microphone', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).final('Dime algo');
  f.tick(850);
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

test('changing tabs stops microphone and resumes the actual pending reply on return, with no background speech', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).final('Consulta de voz');
  f.tick(850);
  await settle();
  f.browser.document.hidden = true;
  f.listeners.get('visibilitychange')();
  f.controller.update({ busy: false, completedTurn: { id: 'hidden', text: 'Respuesta guardada.', ok: true } });
  assert.equal(f.spoken.length, 0);
  f.browser.document.hidden = false;
  f.listeners.get('visibilitychange')();
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].text, 'Respuesta guardada.');
  assert.equal(f.submissions.length, 1);
  f.controller.destroy();
});

test('rejected message and disconnected stream fail without automatic request repetition', async () => {
  for (const rejected of [false, true]) {
    const f = fixture({ submit: async () => rejected ? false : true });
    f.start();
    f.recognizers.at(-1).final('No repitas esta acción');
    f.tick(850);
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
  f.start();
  f.recognizers.at(-1).final('Prueba');
  f.tick(850);
  await settle();
  f.controller.update({ completedTurn: { id: 'hung', text: 'Audio que no termina.', ok: true } });
  f.tick(46200);
  assert.equal(f.controller.getState().status, 'error');
  assert.match(f.controller.getState().error, /lectura de voz se ha detenido/);
  assert.equal(f.recognizers.length, 1);
  f.controller.destroy();
});

test('a hung response pauses voice without cancelling or resending an external action', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).final('Mensaje que espera respuesta');
  f.tick(850);
  await settle();
  f.controller.update({ busy: true });
  f.tick(75000);
  assert.equal(f.controller.getState().status, 'error');
  assert.match(f.controller.getState().error, /No se repetirá ninguna acción/);
  assert.equal(f.submissions.length, 1);
  assert.equal(f.recognizers.length, 1);
  f.controller.destroy();
});

test('unavailable browser gives explicit support instructions and can always close', () => {
  const f = fixture({ unsupported: true });
  assert.equal(f.controller.getState().supported, false);
  f.start();
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
  f.start();
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

test('the launch gesture plays an audible Spanish greeting before opening the microphone', () => {
  const f = fixture({ autoGreeting: false, voices: [] });
  f.controller.start();
  const greeting = f.playbacks[0];
  assert.equal(greeting.text, VOICE_GREETING);
  assert.equal(greeting.lang, 'es-ES');
  assert.equal(greeting.volume, 1);
  assert.equal('voice' in greeting, false, 'do not assign a null voice on Safari');
  assert.equal(f.controller.getState().status, 'speaking');
  assert.equal(f.recognizers.length, 0, 'the microphone cannot hear the greeting');
  assert.equal(f.submissions.length, 0);
  greeting.onend();
  f.tick(400);
  assert.equal(f.recognizers.length, 1);
  assert.equal(f.controller.getState().status, 'listening');
  f.controller.destroy();
});

test('a gesture-locked engine is unlocked before any asynchronous model response', async () => {
  const f = fixture();
  const nativeSpeak = f.browser.speechSynthesis.speak;
  let insideGesture = false;
  let unlocked = false;
  f.browser.speechSynthesis.speak = current => {
    if (insideGesture) unlocked = true;
    if (!unlocked) { current.onerror?.({ error: 'not-allowed' }); return; }
    nativeSpeak(current);
  };
  insideGesture = true;
  f.start();
  insideGesture = false;
  f.recognizers.at(-1).final('Dime cuatro');
  f.tick(850);
  await settle();
  f.controller.update({ completedTurn: { id: 'unlocked', text: 'Cuatro.', ok: true } });
  assert.equal(unlocked, true);
  assert.equal(f.controller.getState().status, 'speaking');
  assert.equal(f.spoken.at(-1).text, 'Cuatro.');
  f.controller.destroy();
});

test('waits for voiceschanged on asynchronous playback and prefers installed Spanish voices', async () => {
  const f = fixture({ voices: [] });
  f.start();
  f.recognizers.at(-1).final('Respóndeme');
  f.tick(850);
  await settle();
  f.controller.update({ completedTurn: { id: 'voices', text: 'Ya tengo voz.', ok: true } });
  assert.equal(f.spoken.length, 0);
  assert.equal(f.controller.getState().status, 'starting_audio');
  f.tick(300);
  const local = { lang: 'es-ES', localService: true, name: 'Español instalado' };
  f.setVoices([{ lang: 'en-US' }, { lang: 'es-ES', localService: false }, local]);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].voice, local);
  f.setVoices([local]);
  f.tick(1200);
  assert.equal(f.spoken.length, 1, 'voiceschanged must not enqueue a duplicate');
  f.controller.destroy();
});

test('missing voice events have a bounded wait and use the system Spanish voice without null assignment', async () => {
  const f = fixture({ voices: [] });
  f.start();
  f.recognizers.at(-1).final('Prueba');
  f.tick(850);
  await settle();
  f.controller.update({ completedTurn: { id: 'system-voice', text: 'Una respuesta.', ok: true } });
  f.tick(1199);
  assert.equal(f.spoken.length, 0);
  f.tick(1);
  assert.equal(f.spoken.length, 1);
  assert.equal(f.spoken[0].lang, 'es-ES');
  assert.equal('voice' in f.spoken[0], false);
  f.controller.destroy();
});

test('blocked playback keeps the answer and a new gesture retries sound without resending the request', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).final('Envíame cuatro por WhatsApp');
  f.tick(850);
  await settle();
  const nativeSpeak = f.browser.speechSynthesis.speak;
  f.browser.speechSynthesis.speak = current => current.onerror({ error: 'not-allowed' });
  f.controller.update({ completedTurn: { id: 'blocked', text: 'El mensaje se ha enviado.', ok: true } });
  assert.equal(f.controller.getState().status, 'error');
  assert.match(f.controller.getState().error, /bloqueó el altavoz/);
  assert.equal(f.controller.getState().lastReply, 'El mensaje se ha enviado.');
  f.browser.speechSynthesis.speak = nativeSpeak;
  f.controller.resume();
  assert.equal(f.spoken.at(-1).text, 'El mensaje se ha enviado.');
  assert.equal(f.submissions.length, 1, 'retrying audio never sends another WhatsApp');
  assert.equal(f.recognizers.length, 1);
  f.spoken.at(-1).onend();
  f.tick(400);
  assert.equal(f.recognizers.length, 2);
  f.controller.destroy();
});

test('does not report speaking before audio starts; silent completion and a stalled engine need recovery', async () => {
  for (const silentEnd of [true, false]) {
    const f = fixture();
    f.start();
    f.recognizers.at(-1).final('Una respuesta');
    f.tick(850);
    await settle();
    f.browser.speechSynthesis.speak = current => {
      f.spoken.push(current);
      if (silentEnd) current.onend();
    };
    f.controller.update({ completedTurn: { id: 'silent', text: 'Respuesta conservada.', ok: true } });
    if (!silentEnd) {
      assert.equal(f.controller.getState().status, 'starting_audio');
      f.tick(13200);
    }
    if (silentEnd) f.tick(1200);
    assert.equal(f.controller.getState().status, 'error');
    assert.equal(f.controller.getState().lastReply, 'Respuesta conservada.');
    assert.equal(f.recognizers.length, 1);
    assert.equal(f.submissions.length, 1);
    f.controller.destroy();
  }
});

test('replay and speaker test only play sound and do not create another model or tool turn', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).final('Cuánto es dos más dos');
  f.tick(850);
  await settle();
  f.controller.update({ completedTurn: { id: 'replay', text: 'Dos más dos son cuatro.', ok: true } });
  f.spoken.at(-1).onend();
  f.tick(400);
  f.controller.replay();
  assert.equal(f.spoken.length, 2);
  assert.equal(f.spoken[1].text, f.spoken[0].text);
  assert.equal(f.recognizers.at(-1).aborted, true);
  f.controller.testSpeaker();
  assert.equal(f.playbacks.at(-1).text, VOICE_GREETING);
  f.tick(400);
  assert.deepEqual(f.submissions, ['Cuánto es dos más dos']);
  f.controller.destroy();
});

test('multiple speech chunks retain the answer until all finish and never reopen the microphone between chunks', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).final('Dame una explicación');
  f.tick(850);
  await settle();
  const text = 'Una frase para escuchar. '.repeat(30);
  f.controller.update({ completedTurn: { id: 'chunks', text, ok: true } });
  for (let i = 0; i < speechChunks(text).length; i += 1) {
    assert.equal(f.recognizers.length, 1);
    assert.equal(f.controller.getState().status, 'speaking');
    f.spoken.at(-1).onend();
  }
  assert.equal(f.spoken.map(current => current.text).join(' '), voiceText(text));
  f.tick(400);
  assert.equal(f.recognizers.length, 2);
  f.controller.destroy();
});

test('microphone permission is requested in the launch gesture and its temporary stream is released before recognition', async () => {
  const f = fixture();
  let allow;
  const calls = [];
  let stopped = 0;
  f.browser.navigator = { mediaDevices: { getUserMedia(options) {
    calls.push(options);
    return new Promise(resolve => { allow = resolve; });
  } } };
  f.start();
  assert.deepEqual(calls, [{ audio: true }]);
  assert.equal(f.playbacks[0].text, VOICE_GREETING, 'sound must not wait for the asynchronous permission result');
  assert.equal(f.recognizers.length, 0);
  assert.equal(f.controller.getState().status, 'starting_mic');
  allow({ getTracks: () => [{ stop() { stopped += 1; } }] });
  await settle();
  f.tick(400);
  assert.equal(stopped, 1);
  assert.equal(f.recognizers.length, 1);
  f.controller.destroy();
});

test('closing while permission is pending releases late microphone tracks without restarting the session', async () => {
  const f = fixture();
  let allow;
  let stopped = 0;
  f.browser.navigator = { mediaDevices: { getUserMedia: () => new Promise(resolve => { allow = resolve; }) } };
  f.start();
  f.controller.stop();
  allow({ getTracks: () => [{ stop() { stopped += 1; } }] });
  await settle();
  f.tick(10000);
  assert.equal(stopped, 1);
  assert.equal(f.controller.getState().active, false);
  assert.equal(f.recognizers.length, 0);
  assert.equal(f.timers.size, 0);
  f.controller.destroy();
});

test('microphone permission denial pauses once and a manual retry can recover', async () => {
  const f = fixture();
  f.browser.navigator = { mediaDevices: { getUserMedia: () => Promise.reject({ name: 'NotAllowedError' }) } };
  f.start();
  await settle();
  assert.equal(f.controller.getState().status, 'error');
  assert.match(f.controller.getState().error, /micrófono está bloqueado/);
  f.tick(100000);
  assert.equal(f.recognizers.length, 0);
  let stopped = false;
  f.browser.navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [{ stop() { stopped = true; } }] });
  f.controller.resume();
  await settle();
  f.tick(400);
  assert.equal(stopped, true);
  assert.equal(f.recognizers.length, 1);
  assert.equal(f.controller.getState().status, 'listening');
  f.controller.destroy();
});

test('streams stable sentences before completion without reading incomplete words or repeating the answer', async () => {
  const f = fixture();
  f.start();
  f.recognizers.at(-1).final('Dime el resultado');
  f.tick(850); await settle();
  f.controller.update({ busy: true, liveTurn: { id: 'stream', text: 'Dos más dos son' } });
  assert.equal(f.spoken.length, 0);
  f.controller.update({ busy: true, liveTurn: { id: 'stream', text: 'Dos más dos son cuatro. Otra' } });
  assert.equal(f.spoken[0].text, 'Dos más dos son cuatro.');
  assert.equal(f.controller.getState().status, 'speaking');
  const full = 'Dos más dos son cuatro. Otra frase.';
  f.controller.update({ busy: true, liveTurn: { id: 'stream', text: full } });
  f.spoken[0].onend();
  assert.equal(f.controller.getState().status, 'thinking');
  f.tick(1000);
  assert.equal(f.recognizers.length, 1, 'cannot accept another turn while the server is still working');
  f.controller.update({ busy: false, liveTurn: { id: 'stream', text: full }, completedTurn: { id: 'stream', text: full, ok: true } });
  assert.equal(f.spoken[1].text, 'Otra frase.');
  f.controller.update({ completedTurn: { id: 'stream', text: full, ok: true } });
  assert.equal(f.spoken.length, 2);
  f.spoken[1].onend(); f.tick(400);
  assert.equal(f.controller.getState().status, 'listening');
  assert.equal(f.submissions.length, 1);
  f.controller.destroy();
});

test('200 successive turns, including repeated requests, speak exactly once and clean up every browser resource', async () => {
  const f = fixture();
  f.start();
  for (let turn = 0; turn < 200; turn += 1) {
    f.recognizers.at(-1).final('Cuánto es dos más dos');
    f.tick(850); await settle();
    f.controller.update({ busy: true, liveTurn: { id: `long-${turn}`, text: 'Son cuatro. ' } });
    const utterance = f.spoken.at(-1);
    utterance.onend();
    f.controller.update({ busy: false, completedTurn: { id: `long-${turn}`, text: 'Son cuatro. ', ok: true } });
    f.tick(400);
    assert.equal(f.controller.getState().status, 'listening');
    assert.equal(f.spoken.length, turn + 1);
    assert.equal(f.submissions.length, turn + 1);
    assert.ok(f.timers.size <= 2, 'timers cannot accumulate between turns');
  }
  f.controller.destroy();
  assert.equal(f.timers.size, 0);
  assert.equal(f.events.size, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.voiceListeners.size, 0);
});

test('temporary speaker failure automatically retries audio only, never the model or WhatsApp', async () => {
  const f = fixture(); f.start();
  f.recognizers.at(-1).final('Envía cuatro'); f.tick(850); await settle();
  const nativeSpeak = f.browser.speechSynthesis.speak;
  let attempts = 0;
  f.browser.speechSynthesis.speak = current => {
    attempts += 1;
    if (attempts === 1) current.onerror({ error: 'audio-busy' });
    else nativeSpeak(current);
  };
  f.controller.update({ completedTurn: { id: 'retry-audio', text: 'Mensaje enviado.', ok: true } });
  assert.equal(f.controller.getState().status, 'recovering');
  f.tick(400);
  assert.equal(f.controller.getState().status, 'speaking');
  assert.equal(attempts, 2);
  assert.equal(f.submissions.length, 1);
  f.spoken.at(-1).onend(); f.tick(400);
  assert.equal(f.controller.getState().status, 'listening');
  f.controller.destroy();
});

test('a browser that silently pauses its native speaker is resumed without enqueueing another utterance', async () => {
  const f = fixture(); f.start();
  f.recognizers.at(-1).final('Lee una respuesta'); f.tick(850); await settle();
  f.controller.update({ completedTurn: { id: 'native-pause', text: 'Respuesta hablada.', ok: true } });
  let resumed = 0;
  f.browser.speechSynthesis.paused = true;
  f.browser.speechSynthesis.resume = () => { resumed += 1; f.browser.speechSynthesis.paused = false; };
  f.tick(1000);
  assert.equal(resumed, 1);
  assert.equal(f.spoken.length, 1);
  f.controller.destroy();
});

test('offline and foreground recovery keeps the pending answer without repeating an external action', async () => {
  const f = fixture(); f.start();
  f.recognizers.at(-1).final('Envía el mensaje'); f.tick(850); await settle();
  f.controller.update({ busy: true });
  f.browser.navigator.onLine = false; f.events.get('offline')();
  assert.equal(f.controller.getState().status, 'offline');
  assert.equal(f.recognizers.at(-1).aborted, true);
  f.browser.document.hidden = true; f.listeners.get('visibilitychange')();
  f.controller.update({ completedTurn: { id: 'offline-answer', text: 'Solicitud completada.', ok: true } });
  f.browser.navigator.onLine = true; f.events.get('online')();
  assert.equal(f.spoken.length, 0, 'never speaks in a hidden tab');
  f.browser.document.hidden = false; f.listeners.get('visibilitychange')();
  assert.equal(f.spoken[0].text, 'Solicitud completada.');
  assert.equal(f.submissions.length, 1);
  f.spoken[0].onend(); f.tick(400);
  assert.equal(f.controller.getState().status, 'listening');
  f.controller.destroy();
});

test('manual pause is respected after Internet recovers or the tab becomes visible', async () => {
  const f = fixture(); f.start();
  f.recognizers.at(-1).final('Responde'); f.tick(850); await settle();
  f.controller.pause();
  f.controller.update({ completedTurn: { id: 'manual-paused', text: 'Respuesta pendiente.', ok: true } });
  f.browser.document.hidden = true; f.listeners.get('visibilitychange')();
  f.browser.navigator.onLine = false; f.events.get('offline')();
  f.browser.navigator.onLine = true; f.events.get('online')();
  f.browser.document.hidden = false; f.listeners.get('visibilitychange')();
  f.tick(10000);
  assert.equal(f.controller.getState().pauseReason, 'manual');
  assert.equal(f.spoken.length, 0);
  f.controller.resume();
  assert.equal(f.spoken[0].text, 'Respuesta pendiente.');
  assert.equal(f.submissions.length, 1);
  f.controller.destroy();
});

test('a late real answer recovers a reply timeout without another submission', async () => {
  const f = fixture(); f.start();
  f.recognizers.at(-1).final('Pregunta lenta'); f.tick(850); await settle();
  f.controller.update({ busy: true }); f.tick(75000);
  assert.equal(f.controller.getState().pauseReason, 'reply-timeout');
  f.controller.update({ busy: false, completedTurn: { id: 'late-result', text: 'Respuesta real recibida.', ok: true } });
  assert.equal(f.controller.getState().status, 'speaking');
  assert.equal(f.spoken[0].text, 'Respuesta real recibida.');
  assert.equal(f.submissions.length, 1);
  f.controller.destroy();
});

test('voice and pace preferences persist and only affect future utterances', async () => {
  const voice = { lang: 'es-MX', name: 'Mi voz', voiceURI: 'my-spanish-voice' };
  const f = fixture({ voices: [{ lang: 'es-ES' }, voice] }); f.start();
  f.controller.configure({ voiceURI: voice.voiceURI, rate: 1.2, pauseMs: 1200 });
  assert.equal(f.saved.size, 1);
  f.recognizers.at(-1).final('Respuesta'); f.tick(1199);
  assert.equal(f.submissions.length, 0);
  f.tick(1); await settle();
  f.controller.update({ completedTurn: { id: 'preferences', text: 'Voz elegida.', ok: true } });
  assert.equal(f.spoken[0].voice, voice);
  assert.equal(f.spoken[0].rate, 1.2);
  f.controller.configure({ rate: 0.85 });
  assert.equal(f.spoken[0].rate, 1.2);
  f.controller.destroy();
});

test('screen wake lock is held only during an active visible conversation and released on pause and destroy', async () => {
  const f = fixture(); let requested = 0, released = 0;
  f.browser.navigator.wakeLock = { request: async kind => {
    assert.equal(kind, 'screen'); requested += 1;
    return { release: async () => { released += 1; }, addEventListener() {} };
  } };
  f.start(); await settle();
  assert.equal(f.controller.getState().awake, true);
  f.controller.pause(); await settle();
  assert.equal(released, 1);
  assert.equal(f.controller.getState().awake, false);
  f.controller.resume(); await settle();
  assert.equal(requested, 2);
  f.controller.destroy(); await settle();
  assert.equal(released, 2);
});

test('a wake lock resolving after close is released and cannot restart the session', async () => {
  const f = fixture(); let allow, released = 0;
  f.browser.navigator.wakeLock = { request: () => new Promise(resolve => { allow = resolve; }) };
  f.start(); await settle(); f.controller.destroy();
  allow({ release: async () => { released += 1; } }); await settle();
  assert.equal(released, 1);
  assert.equal(f.controller.getState().active, false);
  assert.equal(f.timers.size, 0);
});
