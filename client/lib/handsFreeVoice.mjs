const RECOGNITION_WAIT_MS = 45000;
const FINAL_PAUSE_MS = 700;
const RESTART_PAUSE_MS = 400;
const REPLY_WAIT_MS = 75000;
const SPEECH_START_WAIT_MS = 8000;
const VOICE_LOAD_WAIT_MS = 1200;
export const VOICE_GREETING = "Hola, soy tu Dot. Ya puedes hablar conmigo.";
const VOICE_RESUME = "Te escucho.";

export function voiceText(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " He dejado el código en el chat. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "el enlace del chat")
    .replace(/(^|\n)\s{0,3}[#>*-]+\s*/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speechChunks(text, maxLength = 220) {
  const clean = voiceText(text);
  let remaining = clean.length > 6000
    ? `${clean.slice(0, 6000)}. Puedes leer el resto en el chat.`
    : clean;
  const chunks = [];
  while (remaining) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const prefix = remaining.slice(0, maxLength);
    const sentence = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("? "), prefix.lastIndexOf("! "));
    const space = prefix.lastIndexOf(" ");
    const cut = sentence > maxLength / 3 ? sentence + 1 : space > 0 ? space : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}

/** Browser speech controller. Recognition is always stopped before a request or playback. */
export function createHandsFreeVoice({ browser, onSubmit, onState }) {
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  const synthesis = browser.speechSynthesis;
  const supported = Boolean(typeof Recognition === "function" && synthesis && typeof browser.SpeechSynthesisUtterance === "function");
  let state = { supported, active: false, status: "idle", transcript: "", error: "", paused: false, lastReply: "" };
  let disposed = false;
  let generation = 0;
  let recognition = null;
  let utterance = null;
  let awaitingReply = false;
  let busy = false;
  let approvalPending = false;
  let lastCompletedId = null;
  let deferredSpeech = null;
  let pendingVoiceStart = null;
  let microphonePending = false;
  let finalTranscript = "";
  const timers = new Map();

  function emit(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    onState({ ...state });
  }

  function clearTimer(name) {
    if (timers.has(name)) browser.clearTimeout(timers.get(name));
    timers.delete(name);
  }

  function schedule(name, callback, delay) {
    clearTimer(name);
    const currentGeneration = generation;
    timers.set(name, browser.setTimeout(() => {
      timers.delete(name);
      if (!disposed && generation === currentGeneration) callback();
    }, delay));
  }

  function clearTimers() {
    for (const name of timers.keys()) clearTimer(name);
  }

  function stopRecognition() {
    clearTimer("recognition");
    clearTimer("final");
    clearTimer("restart");
    const current = recognition;
    recognition = null;
    if (!current) return;
    current.onstart = current.onresult = current.onerror = current.onend = null;
    try { current.abort(); } catch {}
  }

  function stopSpeech() {
    clearTimer("speech");
    clearTimer("speech-start");
    clearTimer("voices");
    pendingVoiceStart = null;
    if (utterance) utterance.onstart = utterance.onend = utterance.onerror = null;
    utterance = null;
    try { synthesis?.cancel(); } catch {}
  }

  function fail(message) {
    clearTimer("reply");
    stopRecognition();
    stopSpeech();
    emit({ status: "error", error: message, paused: true });
  }

  function canListen() {
    return state.active && !state.paused && !busy && !approvalPending && !awaitingReply && !disposed && !microphonePending && !isOutputPending();
  }

  function isOutputPending() {
    return state.status === "starting_audio" || state.status === "speaking";
  }

  function requestMicrophone() {
    const devices = browser.navigator?.mediaDevices;
    if (typeof devices?.getUserMedia !== "function") return true;
    const currentGeneration = generation;
    microphonePending = true;
    const denied = (error) => {
      if (disposed || currentGeneration !== generation || !state.active) return;
      microphonePending = false;
      fail(error?.name === "NotAllowedError"
        ? "El micrófono está bloqueado. Permítelo en los ajustes de este sitio y pulsa Reintentar voz."
        : "No se ha podido abrir el micrófono. Revisa sus permisos y si otra aplicación lo está usando.");
    };
    try {
      // Ask inside the launch/resume gesture, before the spoken greeting finishes on iOS.
      Promise.resolve(devices.getUserMedia({ audio: true })).then(stream => {
        // Recognition owns its own capture. This permission-only stream must always be released.
        for (const track of stream.getTracks()) track.stop();
        if (disposed || currentGeneration !== generation || !state.active) return;
        microphonePending = false;
        syncStatus();
      }).catch(denied);
      return true;
    } catch (error) {
      denied(error);
      return false;
    }
  }

  async function submitTranscript() {
    if (!canListen()) return;
    const text = finalTranscript.trim();
    if (!text) return;
    stopRecognition();
    finalTranscript = "";
    awaitingReply = true;
    const currentGeneration = generation;
    emit({ status: "thinking", transcript: text, error: "" });
    waitForReply();
    try {
      const accepted = await onSubmit(text);
      if (disposed || currentGeneration !== generation || !state.active) return;
      if (accepted === false) {
        awaitingReply = false;
        fail("No se ha enviado tu mensaje. Revisa el chat y pulsa Reintentar voz cuando puedas continuar.");
      }
    } catch {
      if (disposed || currentGeneration !== generation || !state.active) return;
      awaitingReply = false;
      fail("No se pudo enviar tu mensaje. Comprueba la conexión y el chat antes de repetirlo.");
    }
  }

  function waitForReply() {
    if (timers.has("reply") || approvalPending) return;
    schedule("reply", () => {
      awaitingReply = false;
      fail("La respuesta está tardando demasiado. Revisa el chat antes de repetirla; una acción que ya autorizaste puede seguir en curso.");
    }, REPLY_WAIT_MS);
  }

  function listen() {
    if (!canListen()) return;
    stopSpeech();
    stopRecognition();
    finalTranscript = "";
    const currentGeneration = generation;
    let current;
    try {
      current = new Recognition();
    } catch {
      fail("Este navegador no ha podido iniciar la escucha. Prueba Safari o Chrome compatibles, o escribe en el chat.");
      return;
    }
    recognition = current;
    current.lang = "es-ES";
    current.continuous = false;
    current.interimResults = true;
    current.maxAlternatives = 1;
    const valid = () => !disposed && currentGeneration === generation && recognition === current && canListen();
    current.onstart = () => {
      if (valid()) emit({ status: "listening", transcript: "", error: "" });
    };
    current.onresult = (event) => {
      if (!valid()) return;
      const finalParts = [];
      const interimParts = [];
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index];
        const text = result[0]?.transcript || "";
        (result.isFinal ? finalParts : interimParts).push(text);
      }
      finalTranscript = finalParts.join(" ").trim();
      emit({ transcript: [...finalParts, ...interimParts].join(" ").trim() });
      clearTimer("final");
      // Interim words mean the person is still talking; only final words are sent.
      if (finalTranscript && interimParts.length === 0) schedule("final", submitTranscript, FINAL_PAUSE_MS);
    };
    current.onerror = (event) => {
      if (!valid()) return;
      if (event.error === "no-speech" || event.error === "aborted") return;
      const messages = {
        "not-allowed": "El micrófono está bloqueado. Permítelo en los ajustes de este sitio y pulsa Reintentar voz.",
        "service-not-allowed": "Este navegador no permite el reconocimiento de voz. Prueba Safari o Chrome compatibles, o escribe en el chat.",
        "audio-capture": "No se encuentra un micrófono disponible. Revisa sus permisos y si otra aplicación lo está usando.",
        network: "El reconocimiento de voz perdió la conexión. Revisa Internet y pulsa Reintentar voz.",
        "language-not-supported": "El reconocimiento de español no está disponible en este navegador. Puedes seguir escribiendo.",
      };
      fail(messages[event.error] || "La escucha se ha interrumpido. Pulsa Reintentar voz o escribe en el chat.");
    };
    current.onend = () => {
      if (!valid()) return;
      recognition = null;
      clearTimer("recognition");
      clearTimer("final");
      if (finalTranscript) submitTranscript();
      else {
        emit({ status: "listening" });
        schedule("restart", listen, RESTART_PAUSE_MS);
      }
    };
    emit({ status: "listening", transcript: "", error: "" });
    try {
      current.start();
      schedule("recognition", () => {
        if (!valid()) return;
        stopRecognition();
        if (finalTranscript) submitTranscript();
        else schedule("restart", listen, RESTART_PAUSE_MS);
      }, RECOGNITION_WAIT_MS);
    } catch {
      fail("No se pudo iniciar el micrófono. Pulsa Reintentar voz y permite el acceso cuando el navegador lo solicite.");
    }
  }

  function availableVoices() {
    try { return synthesis.getVoices?.() || []; } catch { return []; }
  }

  function voicesChanged() {
    if (!availableVoices().length || !pendingVoiceStart) return;
    const begin = pendingVoiceStart;
    pendingVoiceStart = null;
    clearTimer("voices");
    begin();
  }
  synthesis?.addEventListener?.("voiceschanged", voicesChanged);

  function speak(text, { gesture = false } = {}) {
    stopRecognition();
    stopSpeech();
    const chunks = speechChunks(text);
    if (!chunks.length) {
      deferredSpeech = null;
      emit({ status: "starting_mic", transcript: "" });
      schedule("restart", listen, RESTART_PAUSE_MS);
      return;
    }
    // Keep the response until playback finishes. Retrying sound must never resend a chat/tool request.
    deferredSpeech = chunks.join(" ");
    const currentGeneration = generation;
    emit({ status: "starting_audio", error: "" });
    function next() {
      if (disposed || currentGeneration !== generation || !state.active || state.paused || approvalPending) return;
      const chunk = chunks.shift();
      if (!chunk) {
        utterance = null;
        deferredSpeech = null;
        emit({ status: "starting_mic", transcript: "" });
        // Let speaker output decay before opening the microphone again.
        schedule("restart", listen, RESTART_PAUSE_MS);
        return;
      }
      const current = new browser.SpeechSynthesisUtterance(chunk);
      utterance = current;
      current.lang = "es-ES";
      current.rate = 1.08;
      current.volume = 1;
      current.pitch = 1;
      const voices = availableVoices();
      const spanish = voices.filter(voice => /^es(?:[-_]|$)/i.test(voice.lang || ""));
      const voice = spanish.find(voice => /^es[-_]ES$/i.test(voice.lang) && voice.localService)
        || spanish.find(voice => /^es[-_]ES$/i.test(voice.lang))
        || spanish.find(voice => voice.localService) || spanish[0];
      // Safari can reject an explicitly null voice while its system voices are loading.
      if (voice) current.voice = voice;
      let started = false;
      current.onstart = () => {
        if (utterance !== current || currentGeneration !== generation) return;
        started = true;
        clearTimer("speech-start");
        emit({ status: "speaking", error: "" });
        schedule("speech", () => fail("La lectura de voz se ha detenido. Pulsa Reintentar voz para escuchar la respuesta pendiente."), Math.max(15000, chunk.split(/\s+/).length * 1000 + 4000));
      };
      current.onend = () => {
        if (utterance !== current || currentGeneration !== generation) return;
        clearTimer("speech-start");
        clearTimer("speech");
        if (!started) {
          fail("El navegador no ha iniciado el audio. Pulsa Reintentar voz para activar el altavoz y escuchar la respuesta.");
          return;
        }
        utterance = null;
        next();
      };
      current.onerror = (event) => {
        if (utterance !== current || currentGeneration !== generation) return;
        fail(event?.error === "not-allowed"
          ? "El navegador bloqueó el altavoz. Pulsa Reintentar voz para activar el sonido y escuchar la respuesta."
          : "No se pudo reproducir la respuesta. Pulsa Reintentar voz para escucharla sin volver a enviar tu petición.");
      };
      try {
        // Arm first: some engines dispatch start/end synchronously on short utterances.
        schedule("speech-start", () => fail("El altavoz no ha arrancado. Sube el volumen multimedia y pulsa Reintentar voz para escuchar la respuesta."), SPEECH_START_WAIT_MS);
        synthesis.resume?.();
        synthesis.speak(current);
      } catch {
        fail("Este navegador no ha podido reproducir la respuesta. Puedes leerla en el chat.");
      }
    }
    // The first audible greeting MUST be queued inside the button's user gesture, especially on iOS.
    // Subsequent asynchronous replies may briefly wait for the browser's voiceschanged event.
    if (!gesture && !availableVoices().length) {
      pendingVoiceStart = next;
      schedule("voices", () => {
        const begin = pendingVoiceStart;
        pendingVoiceStart = null;
        begin?.();
      }, VOICE_LOAD_WAIT_MS);
    } else next();
  }

  function syncStatus() {
    if (!state.active || state.paused) return;
    if (approvalPending) {
      clearTimer("reply");
      stopRecognition();
      stopSpeech();
      emit({ status: "approval" });
    } else if (busy || awaitingReply) {
      waitForReply();
      stopRecognition();
      if (!isOutputPending()) emit({ status: "thinking" });
    } else if (!isOutputPending() && !recognition) {
      clearTimer("reply");
      schedule("restart", listen, RESTART_PAUSE_MS);
    }
  }

  function pauseForHiddenPage() {
    if (!browser.document?.hidden || !state.active) return;
    stopRecognition();
    stopSpeech();
    emit({ status: "paused", paused: true, error: "La voz se ha pausado al salir de la pantalla. Vuelve y pulsa Retomar voz." });
  }
  browser.document?.addEventListener("visibilitychange", pauseForHiddenPage);

  return {
    getState: () => ({ ...state }),
    start() {
      if (disposed || state.active) return;
      if (!supported) {
        emit({ active: true, status: "error", paused: true, error: "Este navegador no ofrece escucha y lectura de voz compatibles. En iPhone prueba Safari actualizado; si sigue sin estar disponible, utiliza el chat escrito." });
        return;
      }
      generation += 1;
      awaitingReply = false;
      deferredSpeech = null;
      emit({ active: true, paused: false, status: "listening", error: "", transcript: "" });
      if (!requestMicrophone()) return;
      if (approvalPending || busy) syncStatus();
      else speak(VOICE_GREETING, { gesture: true });
    },
    stop() {
      generation += 1;
      clearTimers();
      stopRecognition();
      stopSpeech();
      awaitingReply = false;
      deferredSpeech = null;
      microphonePending = false;
      emit({ active: false, paused: false, status: "idle", transcript: "", error: "" });
    },
    resume() {
      if (disposed || !state.active || !supported || browser.document?.hidden) return;
      stopRecognition();
      stopSpeech();
      emit({ paused: false, error: "" });
      if (!requestMicrophone()) return;
      if (deferredSpeech && !busy && !approvalPending) {
        const text = deferredSpeech;
        deferredSpeech = null;
        speak(text, { gesture: true });
      } else if (busy || approvalPending || awaitingReply) syncStatus();
      else speak(VOICE_RESUME, { gesture: true });
    },
    testSpeaker() {
      if (disposed || !state.active || !supported || busy || approvalPending || awaitingReply || browser.document?.hidden) return;
      emit({ paused: false, error: "" });
      speak(VOICE_GREETING, { gesture: true });
    },
    replay() {
      if (disposed || !state.active || !state.lastReply || busy || approvalPending || awaitingReply || browser.document?.hidden) return;
      emit({ paused: false, error: "" });
      speak(state.lastReply, { gesture: true });
    },
    interrupt() {
      if (!state.active || !isOutputPending()) return;
      stopSpeech();
      deferredSpeech = null;
      emit({ status: "listening", transcript: "", paused: false });
      schedule("restart", listen, RESTART_PAUSE_MS);
    },
    sendNow() {
      // A button press explicitly confirms the visible draft, including interim words.
      if (!finalTranscript) finalTranscript = state.transcript;
      return submitTranscript();
    },
    update(next) {
      if (disposed) return;
      busy = Boolean(next.busy);
      approvalPending = Boolean(next.approvalPending);
      const completion = next.completedTurn;
      if (completion?.id && completion.id !== lastCompletedId) {
        lastCompletedId = completion.id;
        if (state.active && awaitingReply) {
          clearTimer("reply");
          awaitingReply = false;
          if (completion.ok === false) {
            fail("No se pudo completar la respuesta. Revisa el mensaje del chat antes de volver a pedir una acción.");
          } else if (state.paused || browser.document?.hidden) {
            emit({ lastReply: voiceText(completion.text) });
            deferredSpeech = completion.text;
          } else if (!approvalPending) {
            emit({ lastReply: voiceText(completion.text) });
            speak(completion.text);
          }
        }
      }
      if (next.streamError && state.active && awaitingReply && !busy && !approvalPending) {
        awaitingReply = false;
        fail("La conversación se ha interrumpido. Revisa el chat y, si autorizaste un envío, comprueba WhatsApp antes de repetirlo.");
      }
      syncStatus();
    },
    destroy() {
      this.stop();
      disposed = true;
      browser.document?.removeEventListener("visibilitychange", pauseForHiddenPage);
      synthesis?.removeEventListener?.("voiceschanged", voicesChanged);
    },
  };
}
