import { speechChunks, voiceText, VOICE_GREETING } from "./voiceText.mjs";
import { loadVoicePreferences, normalizeVoicePreferences, saveVoicePreferences, takeSpeechSegments } from "./voicePreferences.mjs";

const RESTART_MS = 400;
const RETRIES = [700, 1500, 3000];

/** One microphone, one speaker queue, one submitted turn. Recovery only restarts browser resources. */
export function createHandsFreeVoice({ browser, onSubmit, onState }) {
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  const synthesis = browser.speechSynthesis;
  const supported = Boolean(typeof Recognition === "function" && synthesis && typeof browser.SpeechSynthesisUtterance === "function");
  let preferences;
  try { preferences = loadVoicePreferences(browser.localStorage); } catch { preferences = normalizeVoicePreferences(); }
  let state = { supported, active: false, status: "idle", paused: false, pauseReason: "", transcript: "", lastReply: "", spokenText: "", speechIndex: 0, error: "", notice: "", voices: [], preferences, awake: false };
  let disposed = false, generation = 0, playbackEpoch = 0;
  let recognition = null, utterance = null, microphonePending = false;
  let awaitingReply = false, busy = false, approvalPending = false;
  let lastCompletedId = null, finalTranscript = "", recoveryAttempts = 0;
  let liveId = null, liveText = "", liveCursor = 0, queuedCharacters = 0;
  let queue = [], pendingVoiceStart = null;
  let wakeLock = null, wakePending = false;
  const timers = new Map();
  const hidden = () => Boolean(browser.document?.hidden);
  const offline = () => browser.navigator?.onLine === false;

  function emit(patch) { if (!disposed) { state = { ...state, ...patch }; onState({ ...state }); } }
  function clearTimer(name) { if (timers.has(name)) browser.clearTimeout(timers.get(name)); timers.delete(name); }
  function schedule(name, callback, delay) {
    clearTimer(name);
    const current = generation;
    timers.set(name, browser.setTimeout(() => { timers.delete(name); if (!disposed && current === generation) callback(); }, delay));
  }
  function clearTimers() { for (const name of timers.keys()) clearTimer(name); }
  function stopRecognition() {
    for (const name of ["recognition", "recognition-start", "stable", "final", "restart", "reconnect"]) clearTimer(name);
    const current = recognition; recognition = null;
    if (current) { current.onstart = current.onresult = current.onerror = current.onend = null; try { current.abort(); } catch {} }
  }
  function stopAudio({ discard = false } = {}) {
    playbackEpoch += 1;
    for (const name of ["speech", "speech-start", "speech-pulse", "speech-retry", "voices"]) clearTimer(name);
    pendingVoiceStart = null;
    if (utterance) utterance.onstart = utterance.onend = utterance.onerror = utterance.onboundary = null;
    utterance = null;
    try { synthesis?.cancel(); } catch {}
    if (discard) queue = [];
  }
  function releaseWakeLock() {
    const current = wakeLock; wakeLock = null;
    if (current) { try { Promise.resolve(current.release()).catch(() => {}); } catch {} }
    emit({ awake: false });
  }
  function keepAwake() {
    if (!state.active || state.paused || hidden() || disposed || wakeLock || wakePending || !browser.navigator?.wakeLock?.request) return;
    const current = generation; wakePending = true;
    Promise.resolve().then(() => browser.navigator.wakeLock.request("screen")).then(lock => {
      wakePending = false;
      if (disposed || current !== generation || !state.active || state.paused || hidden()) { Promise.resolve(lock.release()).catch(() => {}); if (current !== generation) keepAwake(); return; }
      wakeLock = lock;
      emit({ awake: true });
      lock.addEventListener?.("release", () => { if (wakeLock === lock) { wakeLock = null; emit({ awake: false }); } });
    }).catch(() => { wakePending = false; });
  }
  function fail(message, reason = "error") {
    clearTimer("reply"); clearTimer("reply-limit");
    stopRecognition(); stopAudio(); releaseWakeLock();
    emit({ status: "error", paused: true, pauseReason: reason, error: message });
  }
  function pause(reason = "manual") {
    clearTimer("reply"); clearTimer("reply-limit");
    stopRecognition(); stopAudio(); releaseWakeLock();
    const message = reason === "hidden" ? "La conversación se retomará cuando vuelvas a esta pantalla." : reason === "offline" ? "Esperando Internet. Retomaré la conversación al recuperar la conexión." : "Micrófono y altavoz pausados.";
    emit({ paused: true, pauseReason: reason, status: reason === "offline" ? "offline" : "paused", error: "", notice: message });
  }
  function requestMicrophone() {
    const devices = browser.navigator?.mediaDevices;
    if (typeof devices?.getUserMedia !== "function") return true;
    const current = generation; microphonePending = true;
    const denied = error => {
      if (disposed || current !== generation || !state.active) return;
      microphonePending = false;
      fail(error?.name === "NotAllowedError" ? "El micrófono está bloqueado. Permítelo en los ajustes de este sitio y pulsa Reintentar voz." : "No se ha podido abrir el micrófono. Revisa sus permisos y si otra aplicación lo está usando.", "permission");
    };
    try {
      Promise.resolve(devices.getUserMedia({ audio: true })).then(stream => {
        for (const track of stream.getTracks()) track.stop();
        if (disposed || current !== generation || !state.active) return;
        microphonePending = false; syncStatus();
      }).catch(denied);
      return true;
    } catch (error) { denied(error); return false; }
  }
  const available = () => state.active && !state.paused && !disposed && !hidden() && !offline();
  const outputPending = () => Boolean(utterance || pendingVoiceStart || timers.has("speech-retry"));
  const canListen = () => available() && !busy && !approvalPending && !awaitingReply && !microphonePending && !outputPending() && !queue.length;

  function waitForReply({ progress = false } = {}) {
    if (!awaitingReply || approvalPending || state.paused) return;
    if (progress) clearTimer("reply");
    const timeout = () => fail("La respuesta está tardando demasiado. Puedes esperar aquí: la leeré cuando llegue. No se repetirá ninguna acción.", "reply-timeout");
    if (!timers.has("reply")) schedule("reply", timeout, 75000);
    if (!timers.has("reply-limit")) schedule("reply-limit", timeout, 180000);
  }
  async function submitTranscript() {
    if (!canListen()) return;
    const text = finalTranscript.trim(); if (!text) return;
    stopRecognition(); finalTranscript = ""; recoveryAttempts = 0;
    liveId = null; liveText = ""; liveCursor = 0; queuedCharacters = 0;
    awaitingReply = true;
    const current = generation;
    emit({ status: "thinking", transcript: text, lastReply: "", spokenText: "", speechIndex: 0, error: "", notice: "" });
    waitForReply();
    try {
      const accepted = await onSubmit(text);
      if (disposed || current !== generation || !state.active) return;
      if (accepted === false) { awaitingReply = false; fail("No se ha enviado tu mensaje. Revisa el chat y pulsa Reintentar voz cuando puedas continuar.", "submit"); }
    } catch {
      if (disposed || current !== generation || !state.active) return;
      awaitingReply = false;
      fail("No se pudo enviar tu mensaje. Comprueba el chat antes de repetirlo.", "submit");
    }
  }
  function recoverRecognition() {
    stopRecognition();
    if (offline()) { pause("offline"); return; }
    if (recoveryAttempts >= RETRIES.length) { fail("El reconocimiento de voz perdió la conexión varias veces. Revisa Internet y pulsa Reintentar voz.", "recognition"); return; }
    const delay = RETRIES[recoveryAttempts++];
    emit({ status: "recovering", notice: `Reconectando el micrófono (${recoveryAttempts}/${RETRIES.length})…`, error: "" });
    schedule("reconnect", listen, delay);
  }
  function listen() {
    if (!canListen()) return;
    stopAudio(); stopRecognition(); finalTranscript = "";
    const currentGeneration = generation;
    let current;
    try { current = new Recognition(); } catch { fail("Este navegador no ha podido iniciar la escucha. Prueba Safari o Chrome actualizados.", "permission"); return; }
    recognition = current;
    current.lang = "es-ES"; current.continuous = true; current.interimResults = true; current.maxAlternatives = 1;
    const valid = () => currentGeneration === generation && recognition === current && canListen();
    current.onstart = () => {
      if (!valid()) return;
      clearTimer("recognition-start");
      emit({ status: "listening", transcript: "", error: "", notice: "" });
      schedule("stable", () => { if (valid()) recoveryAttempts = 0; }, 10000);
    };
    current.onresult = event => {
      if (!valid()) return;
      const finals = [], interim = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        (result.isFinal ? finals : interim).push(result[0]?.transcript || "");
      }
      finalTranscript = finals.join(" ").trim();
      emit({ transcript: [...finals, ...interim].join(" ").trim() });
      clearTimer("final");
      if (finalTranscript && !interim.length) { recoveryAttempts = 0; schedule("final", submitTranscript, state.preferences.pauseMs); }
    };
    current.onerror = event => {
      if (!valid()) return;
      if (["no-speech", "aborted"].includes(event.error)) return;
      if (event.error === "network") { recoverRecognition(); return; }
      const messages = {
        "not-allowed": "El micrófono está bloqueado. Permítelo en los ajustes de este sitio y pulsa Reintentar voz.",
        "service-not-allowed": "Este navegador no permite el reconocimiento de voz. Prueba Safari o Chrome actualizados.",
        "audio-capture": "No se encuentra un micrófono disponible. Revisa sus permisos y si otra aplicación lo está usando.",
        "language-not-supported": "El reconocimiento de español no está disponible en este navegador.",
      };
      fail(messages[event.error] || "La escucha se ha interrumpido. Pulsa Reintentar voz.", "permission");
    };
    current.onend = () => {
      if (!valid()) return;
      recognition = null; clearTimer("recognition"); clearTimer("recognition-start"); clearTimer("stable"); clearTimer("final");
      if (finalTranscript) submitTranscript(); else { emit({ status: "starting_mic" }); schedule("restart", listen, RESTART_MS); }
    };
    emit({ status: "starting_mic", error: "" });
    try {
      schedule("recognition-start", () => { if (valid()) recoverRecognition(); }, 5000);
      current.start();
      schedule("recognition", () => {
        if (!valid()) return;
        stopRecognition();
        if (finalTranscript) submitTranscript(); else schedule("restart", listen, RESTART_MS);
      }, 45000);
    } catch (error) {
      if (error?.name === "InvalidStateError") recoverRecognition();
      else fail("No se pudo iniciar el micrófono. Pulsa Reintentar voz y permite el acceso cuando el navegador lo solicite.", "permission");
    }
  }
  function availableVoices() { try { return synthesis.getVoices?.() || []; } catch { return []; } }
  function voicesChanged() {
    const voices = availableVoices();
    emit({ voices: voices.filter(voice => /^es(?:[-_]|$)/i.test(voice.lang || "")).map(voice => ({ uri: voice.voiceURI || voice.name || voice.lang, name: voice.name || voice.lang, lang: voice.lang })) });
    if (voices.length && pendingVoiceStart) { const begin = pendingVoiceStart; pendingVoiceStart = null; clearTimer("voices"); begin(); }
  }
  function chooseVoice() {
    const voices = availableVoices();
    const selected = voices.find(voice => (voice.voiceURI || voice.name || voice.lang) === state.preferences.voiceURI);
    const spanish = voices.filter(voice => /^es(?:[-_]|$)/i.test(voice.lang || ""));
    return selected || spanish.find(voice => /^es[-_]ES$/i.test(voice.lang) && voice.localService) || spanish.find(voice => /^es[-_]ES$/i.test(voice.lang)) || spanish.find(voice => voice.localService) || spanish[0];
  }
  function pulseSpeech() {
    if (!utterance || !available()) return;
    try { if (synthesis.paused) synthesis.resume?.(); } catch {}
    schedule("speech-pulse", pulseSpeech, 1000);
  }
  function playNext({ gesture = false } = {}) {
    if (!available() || approvalPending || outputPending()) return;
    if (!queue.length) { syncStatus(); return; }
    stopRecognition();
    const currentGeneration = generation, epoch = playbackEpoch;
    const item = queue[0];
    emit({ status: "starting_audio", spokenText: item.text, speechIndex: 0, error: "" });
    function begin() {
      if (!available() || approvalPending || epoch !== playbackEpoch || currentGeneration !== generation || queue[0] !== item) return;
      let current;
      try { current = new browser.SpeechSynthesisUtterance(item.text); } catch { fail("Este navegador no ha podido reproducir la respuesta.", "audio"); return; }
      utterance = current;
      current.lang = "es-ES"; current.rate = state.preferences.rate; current.volume = 1; current.pitch = 1;
      const voice = chooseVoice(); if (voice) current.voice = voice;
      let started = false;
      const valid = () => utterance === current && epoch === playbackEpoch && currentGeneration === generation && available();
      function audioFailed(error) {
        if (!valid()) return;
        stopAudio();
        if (error === "not-allowed") { fail("El navegador bloqueó el altavoz. Pulsa Reintentar voz para activar el sonido y escuchar la respuesta.", "audio"); return; }
        if (item.attempts < 2) {
          item.attempts += 1;
          emit({ status: "recovering", notice: "Recuperando el altavoz…" });
          schedule("speech-retry", () => playNext(), item.attempts * 400);
        } else fail("La lectura de voz se ha detenido. Pulsa Reintentar voz para escuchar la respuesta pendiente.", "audio");
      }
      current.onstart = () => {
        if (!valid()) return;
        started = true; clearTimer("speech-start");
        emit({ status: "speaking", error: "", notice: "" });
        schedule("speech", () => audioFailed("stalled"), Math.max(15000, item.text.split(/\s+/).length * 1000 + 4000));
        pulseSpeech();
      };
      current.onboundary = event => {
        if (valid() && Number.isFinite(event.charIndex)) emit({ speechIndex: Math.max(0, Math.min(item.text.length, event.charIndex)) });
      };
      current.onend = () => {
        if (!valid()) return;
        if (!started) { audioFailed("silent"); return; }
        for (const name of ["speech", "speech-start", "speech-pulse"]) clearTimer(name);
        current.onstart = current.onend = current.onerror = current.onboundary = null;
        utterance = null; queue.shift();
        emit({ spokenText: "", speechIndex: 0 });
        if (queue.length) playNext(); else syncStatus();
      };
      current.onerror = event => audioFailed(event?.error || "unknown");
      schedule("speech-start", () => audioFailed("stalled"), 4000);
      try { synthesis.resume?.(); synthesis.speak(current); } catch { audioFailed("unavailable"); }
    }
    if (!gesture && !availableVoices().length) {
      pendingVoiceStart = begin;
      schedule("voices", () => { pendingVoiceStart = null; begin(); }, 1200);
    } else begin();
  }
  function appendText(text, { final = false } = {}) {
    if (queuedCharacters >= 6000) return;
    const parsed = takeSpeechSegments(text, liveCursor, final);
    liveCursor = parsed.cursor;
    for (const chunk of speechChunks(parsed.segments.join(" "))) {
      const room = 6000 - queuedCharacters;
      if (!room) break;
      const value = chunk.slice(0, room); queuedCharacters += value.length;
      if (value) queue.push({ text: value, attempts: 0 });
    }
  }
  function speakStandalone(text, { gesture = true } = {}) {
    stopRecognition(); stopAudio({ discard: true });
    queue = speechChunks(text).map(chunk => ({ text: chunk, attempts: 0 }));
    playNext({ gesture });
  }
  function syncStatus() {
    if (!available()) return;
    if (approvalPending) {
      clearTimer("reply"); clearTimer("reply-limit"); stopRecognition(); stopAudio();
      emit({ status: "approval" });
    } else if (queue.length) {
      stopRecognition(); if (!outputPending()) playNext();
    } else if (busy || awaitingReply) {
      waitForReply(); stopRecognition();
      if (!outputPending()) emit({ status: "thinking" });
    } else if (!outputPending() && !recognition && !timers.has("reconnect")) {
      clearTimer("reply"); clearTimer("reply-limit");
      emit({ status: "starting_mic" });
      schedule("restart", listen, RESTART_MS);
    }
  }
  function resume({ gesture = true } = {}) {
    if (disposed || !state.active || !supported || hidden()) return;
    if (offline()) { pause("offline"); return; }
    stopRecognition(); stopAudio(); recoveryAttempts = 0;
    emit({ paused: false, pauseReason: "", error: "", notice: "" });
    keepAwake();
    if (gesture && !requestMicrophone()) return;
    if (queue.length) { queue.forEach(item => { item.attempts = 0; }); playNext({ gesture }); }
    else if (busy || approvalPending || awaitingReply) syncStatus();
    else if (gesture) speakStandalone("Te escucho.");
    else syncStatus();
  }
  function visibilityChanged() {
    if (!state.active) return;
    if (hidden()) { if (!state.paused) pause("hidden"); else releaseWakeLock(); }
    else if (state.pauseReason === "hidden" || state.pauseReason === "offline" && !offline()) resume({ gesture: false });
    else keepAwake();
  }
  function wentOffline() { if (state.active && (!state.paused || state.pauseReason === "hidden")) pause("offline"); }
  function cameOnline() { if (state.active && state.pauseReason === "offline" && !hidden()) resume({ gesture: false }); }
  synthesis?.addEventListener?.("voiceschanged", voicesChanged);
  browser.document?.addEventListener("visibilitychange", visibilityChanged);
  browser.addEventListener?.("offline", wentOffline);
  browser.addEventListener?.("online", cameOnline);
  voicesChanged();

  return {
    getState: () => ({ ...state }),
    start() {
      if (disposed || state.active) return;
      if (!supported) { emit({ active: true, status: "error", paused: true, error: "Este navegador no ofrece escucha y lectura de voz compatibles. En iPhone prueba Safari actualizado; si sigue sin estar disponible, utiliza el chat escrito." }); return; }
      generation += 1; awaitingReply = false; liveId = null; liveText = ""; liveCursor = 0; queuedCharacters = 0; recoveryAttempts = 0;
      emit({ active: true, paused: false, pauseReason: "", status: "starting_audio", error: "", notice: "", transcript: "", lastReply: "" });
      if (offline()) { pause("offline"); return; }
      keepAwake();
      if (!requestMicrophone()) return;
      if (busy || approvalPending) syncStatus(); else speakStandalone(VOICE_GREETING);
    },
    stop() {
      generation += 1; clearTimers(); stopRecognition(); stopAudio({ discard: true }); releaseWakeLock();
      awaitingReply = false; microphonePending = false; recoveryAttempts = 0; liveId = null;
      emit({ active: false, paused: false, pauseReason: "", status: "idle", transcript: "", spokenText: "", error: "", notice: "" });
    },
    resume,
    pause() { if (state.active) pause("manual"); },
    testSpeaker() { if (available() || state.paused && state.active && !hidden() && !offline()) { if (!busy && !approvalPending && !awaitingReply) { emit({ paused: false, pauseReason: "", error: "" }); keepAwake(); speakStandalone(VOICE_GREETING); } } },
    replay() { if (state.active && state.lastReply && !busy && !approvalPending && !awaitingReply && !hidden() && !offline()) { emit({ paused: false, pauseReason: "", error: "" }); keepAwake(); speakStandalone(state.lastReply); } },
    interrupt() {
      if (!state.active || (!outputPending() && !queue.length)) return;
      stopAudio({ discard: true });
      // Stop reading this turn, but retain its server-side execution until it completes.
      queuedCharacters = 6000;
      emit({ spokenText: "", speechIndex: 0, notice: busy || awaitingReply ? "He parado la voz. La petición sigue en curso." : "", status: busy || awaitingReply ? "thinking" : "starting_mic" });
      syncStatus();
    },
    sendNow() { if (!finalTranscript) finalTranscript = state.transcript; return submitTranscript(); },
    configure(value) {
      const preferences = normalizeVoicePreferences({ ...state.preferences, ...value });
      emit({ preferences });
      try { saveVoicePreferences(browser.localStorage, preferences); } catch {}
      if (finalTranscript && canListen()) schedule("final", submitTranscript, preferences.pauseMs);
    },
    update(next) {
      if (disposed) return;
      busy = Boolean(next.busy); approvalPending = Boolean(next.approvalPending);
      const live = next.liveTurn;
      if (state.active && awaitingReply && live?.id && typeof live.text === "string" && (!liveId || liveId === live.id)) {
        liveId = live.id;
        if (live.text.length > liveText.length && live.text.startsWith(liveText)) {
          liveText = live.text;
          emit({ lastReply: voiceText(liveText) });
          appendText(liveText); waitForReply({ progress: true });
        }
      }
      const completion = next.completedTurn;
      if (completion?.id && completion.id !== lastCompletedId) {
        lastCompletedId = completion.id;
        if (state.active && awaitingReply && (!liveId || liveId === completion.id)) {
          clearTimer("reply"); clearTimer("reply-limit"); awaitingReply = false;
          if (completion.ok === false) { stopAudio({ discard: true }); fail("No se pudo completar la respuesta. Revisa el mensaje del chat antes de volver a pedir una acción.", "turn"); }
          else {
            const text = String(completion.text || "");
            emit({ lastReply: voiceText(text) });
            if (liveText && !text.startsWith(liveText)) { stopAudio({ discard: true }); liveCursor = 0; queuedCharacters = 0; }
            appendText(text, { final: true });
            if (state.pauseReason === "reply-timeout" && !hidden() && !offline()) { emit({ paused: false, pauseReason: "", error: "" }); keepAwake(); }
          }
        }
      }
      if (next.streamError && state.active && awaitingReply && !busy && !approvalPending) {
        awaitingReply = false; stopAudio({ discard: true });
        if (offline()) pause("offline");
        else fail("La conversación se ha interrumpido. Revisa el chat y WhatsApp antes de repetir un envío. Retomar voz continúa la conversación sin repetirlo.", "transport");
      }
      syncStatus();
    },
    destroy() {
      this.stop(); disposed = true;
      browser.document?.removeEventListener("visibilitychange", visibilityChanged);
      browser.removeEventListener?.("offline", wentOffline); browser.removeEventListener?.("online", cameOnline);
      synthesis?.removeEventListener?.("voiceschanged", voicesChanged);
    },
  };
}
