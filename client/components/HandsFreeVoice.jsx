"use client";

import { useId, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiHeadphones, FiMic, FiMicOff, FiPause, FiSliders, FiVolume2, FiX } from "react-icons/fi";
import useHandsFreeVoice from "../hooks/useHandsFreeVoice";

const labels = {
  idle: "Modo voz",
  listening: "Te escucho",
  starting_mic: "Abriendo el micrófono",
  thinking: "Preparando tu respuesta",
  starting_audio: "Activando el altavoz",
  speaking: "Dot está hablando",
  approval: "Revisa la autorización en el chat",
  paused: "Voz pausada",
  recovering: "Recuperando la voz",
  offline: "Esperando conexión",
  error: "La voz necesita tu atención",
};

/** Voice reads only this conversation's live SSE turn, never polled history. */
export default function HandsFreeVoice({ botId, botName = "Dot", disabled = false, onSubmit, busy = false, approvalPending = false, liveTurn, completedTurn, streamError, onActivityChange }) {
  const voice = useHandsFreeVoice({ botId, onSubmit, busy, approvalPending, liveTurn, completedTurn, streamError, onActivityChange });
  const panelId = useId();
  const launchRef = useRef(null);
  const closeRef = useRef(null);
  const [minimized, setMinimized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const preferences = voice.preferences || { voiceURI: "", rate: 1.05, pauseMs: 850 };
  const installedVoices = voice.voices || [];
  const selectedVoice = installedVoices.some(item => item.uri === preferences.voiceURI) ? preferences.voiceURI : "";

  useEffect(() => {
    if (voice.active) {
      setMinimized(false);
      setSettingsOpen(false);
      closeRef.current?.focus({ preventScroll: true });
    }
  }, [voice.active]);

  useEffect(() => {
    if (voice.status !== "approval") setMinimized(false);
  }, [voice.status]);

  function close() {
    voice.stop();
    launchRef.current?.focus({ preventScroll: true });
  }

  return (
    <div className="voice-control">
      <button
        ref={launchRef}
        type="button"
        className={`voice-launch ${voice.active ? "is-active" : ""}`}
        aria-label={voice.active ? "Cerrar modo voz" : "Abrir modo voz manos libres"}
        aria-expanded={voice.active}
        aria-controls={voice.active ? panelId : undefined}
        disabled={disabled || voice.supported === null || (busy && !voice.active)}
        onClick={voice.active ? close : voice.start}
        title="Modo voz manos libres"
      >
        <FiHeadphones aria-hidden="true" />
        <span>Voz</span>
      </button>
      {voice.active && createPortal(
        <section
          id={panelId}
          className="voice-panel"
          data-state={voice.status}
          data-minimized={minimized || undefined}
          role={voice.status === "approval" || minimized ? "region" : "dialog"}
          aria-modal={voice.status === "approval" || minimized ? undefined : true}
          aria-label={`Conversación por voz con ${botName}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
            if (event.key === "Tab" && voice.status !== "approval" && !minimized) {
              const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled), select:not(:disabled), input:not(:disabled)")].filter(button => button.getClientRects().length);
              const first = buttons[0];
              const last = buttons.at(-1);
              if (first && event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (last && !event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }
          }}
        >
          <div className="voice-panel-header">
            <div className="voice-identity"><FiHeadphones aria-hidden="true" /><div><strong>Voz con {botName}</strong><small>{voice.awake ? "Pantalla despierta" : "Conversación manos libres"}</small></div></div>
            <button ref={closeRef} type="button" className="voice-close icon-button" aria-label="Cerrar modo voz y apagar el micrófono" onClick={close}><FiX aria-hidden="true" /></button>
          </div>
          <div className="voice-orb" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <p className="voice-status" role="status" aria-live="polite">{labels[voice.status] || labels.idle}</p>
          <div className="voice-captions">
            {voice.transcript && <p className="voice-transcript"><small>Tú</small>{voice.transcript}</p>}
            {voice.spokenText && <p className="voice-reply"><small>{botName}</small><span className="voice-read">{voice.spokenText.slice(0, voice.speechIndex)}</span>{voice.spokenText.slice(voice.speechIndex)}</p>}
          </div>
          {voice.notice && !voice.error && <p className="voice-notice" role="status">{voice.notice}</p>}
          {voice.error && <p className="voice-error" role="alert">{voice.error}</p>}
          {voice.status === "approval" && <p className="voice-approval-note">El micrófono está pausado. Revisa el destinatario y el texto, y pulsa <strong>Autorizar</strong> en la tarjeta del chat. La voz no aprueba acciones.</p>}
          <div className="voice-actions">
            {voice.status === "approval" && <button type="button" className="voice-primary" onClick={() => {
              setMinimized(true);
              const reviewButton = document.querySelector(".chat-action-reviews button");
              reviewButton?.scrollIntoView({ behavior: "smooth", block: "nearest" });
              reviewButton?.focus({ preventScroll: true });
            }}>Revisar en el chat</button>}
            {["speaking", "starting_audio"].includes(voice.status) && <button type="button" className="voice-primary" onClick={voice.interrupt}><FiMic aria-hidden="true" />{busy ? "Parar lectura" : "Interrumpir y hablar"}</button>}
            {voice.status === "listening" && voice.transcript && <button type="button" className="voice-primary" onClick={voice.sendNow}>Enviar ahora</button>}
            {voice.paused && voice.supported && <button type="button" className="voice-primary" onClick={voice.resume}><FiMic aria-hidden="true" />{voice.status === "error" ? "Reintentar voz" : "Retomar voz"}</button>}
            {!voice.paused && voice.supported && voice.status !== "approval" && <button type="button" className="voice-secondary" onClick={voice.pause}><FiPause aria-hidden="true" />Pausar</button>}
            <button type="button" className="voice-secondary" onClick={close}><FiMicOff aria-hidden="true" />Volver a escribir</button>
          </div>
          {voice.supported && !busy && !approvalPending && voice.status !== "thinking" && <div className="voice-speaker-actions">
            <button type="button" className="voice-secondary" onClick={voice.testSpeaker}><FiVolume2 aria-hidden="true" />Probar altavoz</button>
            {voice.lastReply && <button type="button" className="voice-secondary" onClick={voice.replay}><FiVolume2 aria-hidden="true" />Repetir respuesta</button>}
          </div>}
          {voice.supported && <div className="voice-settings">
            <button type="button" className="voice-settings-toggle voice-secondary" aria-expanded={settingsOpen} aria-controls={`${panelId}-settings`} onClick={() => setSettingsOpen(value => !value)}><FiSliders aria-hidden="true" />Voz y ritmo</button>
            {settingsOpen && <div id={`${panelId}-settings`} className="voice-settings-fields">
              <label><span id={`${panelId}-voice-label`}>Voz</span><select aria-labelledby={`${panelId}-voice-label`} value={selectedVoice} onChange={event => voice.configure({ voiceURI: event.target.value })}><option value="">Español automático</option>{installedVoices.map(item => <option key={item.uri} value={item.uri}>{item.name} · {item.lang}</option>)}</select></label>
              <label><span id={`${panelId}-rate-label`}>Velocidad</span><select aria-labelledby={`${panelId}-rate-label`} value={preferences.rate} onChange={event => voice.configure({ rate: Number(event.target.value) })}>{[0.85, 1.05, 1.2, 1.4].map(rate => <option key={rate} value={rate}>{({ 0.85: "Tranquila", 1.05: "Natural", 1.2: "Ágil", 1.4: "Rápida" })[rate]}</option>)}</select></label>
              <label><span id={`${panelId}-pause-label`}>Pausa para enviar</span><select aria-labelledby={`${panelId}-pause-label`} value={preferences.pauseMs} onChange={event => voice.configure({ pauseMs: Number(event.target.value) })}><option value={550}>Corta</option><option value={850}>Normal</option><option value={1200}>Más tiempo</option></select></label>
              <p>Tu elección queda guardada en este dispositivo.</p>
            </div>}
          </div>}
          <p className="voice-help">Habla y haz una pausa. Dot responderá y volverá a escuchar. Mantén la app abierta; la voz se retoma al volver o recuperar Internet. En iPhone usa Safari y permite el micrófono. Si no oyes el saludo, sube el volumen y prueba el altavoz.</p>
        </section>,
        document.body,
      )}
    </div>
  );
}
