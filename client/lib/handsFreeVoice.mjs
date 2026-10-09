const RECOGNITION_WAIT_MS = 45000;
const FINAL_PAUSE_MS = 700;
const RESTART_PAUSE_MS = 400;
const REPLY_WAIT_MS = 75000;

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
  let state = { supported, active: false, status: "idle", transcript: "", error: "", paused: false };
  let disposed = false;
  let generation = 0;
  let recognition = null;
  let utterance = null;
  let awaitingReply = false;
  let busy = false;
  let approvalPending = false;
  let lastCompletedId = null;
  let deferredSpeech = null;
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
    if (utterance) utterance.onend = utterance.onerror = null;
    utterance = null;
    if (supported) synthesis.cancel();
  }

  function fail(message) {
    clearTimer("reply");
    stopRecognition();
    stopSpeech();
    emit({ status: "error", error: message, paused: true });
  }

  function canListen() {
    return state.active && !state.paused && !busy && !approvalPending && !awaitingReply && !disposed;
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

  function speak(text) {
    stopRecognition();
    stopSpeech();
    const chunks = speechChunks(text);
    if (!chunks.length) {
      schedule("restart", listen, RESTART_PAUSE_MS);
      return;
    }
    const currentGeneration = generation;
    emit({ status: "speaking", error: "" });
    function next() {
      if (disposed || currentGeneration !== generation || !state.active || state.paused || approvalPending) return;
      const chunk = chunks.shift();
      if (!chunk) {
        utterance = null;
        emit({ status: "listening", transcript: "" });
        // Let speaker output decay before opening the microphone again.
        schedule("restart", listen, RESTART_PAUSE_MS);
        return;
      }
      const current = new browser.SpeechSynthesisUtterance(chunk);
      utterance = current;
      current.lang = "es-ES";
      current.rate = 1.08;
      const voices = synthesis.getVoices?.() || [];
      current.voice = voices.find(voice => voice.lang === "es-ES") || voices.find(voice => voice.lang?.startsWith("es")) || null;
      current.onend = () => {
        if (utterance !== current || currentGeneration !== generation) return;
        clearTimer("speech");
        utterance = null;
        next();
      };
      current.onerror = () => {
        if (utterance !== current || currentGeneration !== generation) return;
        fail("No se pudo reproducir la respuesta. Puedes leerla en el chat y pulsar Reintentar voz.");
      };
      try {
        synthesis.resume?.();
        synthesis.speak(current);
        schedule("speech", () => fail("La lectura de voz se ha detenido. La respuesta sigue en el chat; pulsa Reintentar voz para continuar."), Math.max(12000, chunk.split(/\s+/).length * 800));
      } catch {
        fail("Este navegador no ha podido reproducir la respuesta. Puedes leerla en el chat.");
      }
    }
    next();
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
      if (state.status !== "speaking") emit({ status: "thinking" });
    } else if (state.status !== "speaking" && !recognition) {
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
      if (approvalPending || busy) syncStatus();
      else listen();
    },
    stop() {
      generation += 1;
      clearTimers();
      stopRecognition();
      stopSpeech();
      awaitingReply = false;
      deferredSpeech = null;
      emit({ active: false, paused: false, status: "idle", transcript: "", error: "" });
    },
    resume() {
      if (disposed || !state.active || !supported || browser.document?.hidden) return;
      stopRecognition();
      stopSpeech();
      emit({ paused: false, error: "" });
      if (deferredSpeech && !busy && !approvalPending) {
        const text = deferredSpeech;
        deferredSpeech = null;
        speak(text);
      } else if (busy || approvalPending || awaitingReply) syncStatus();
      else listen();
    },
    interrupt() {
      if (!state.active || state.status !== "speaking") return;
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
            deferredSpeech = completion.text;
          } else if (!approvalPending) speak(completion.text);
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
    },
  };
}
