"use client";

import { useId, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiHeadphones, FiMic, FiMicOff, FiX } from "react-icons/fi";
import useHandsFreeVoice from "../hooks/useHandsFreeVoice";

const labels = {
  idle: "Modo voz",
  listening: "Te escucho",
  thinking: "Preparando tu respuesta",
  speaking: "Dot está hablando",
  approval: "Revisa la autorización en el chat",
  paused: "Voz pausada",
  error: "La voz necesita tu atención",
};

/** completedTurn is the latest completed SSE turn, never a polled history message. */
export default function HandsFreeVoice({ botId, botName = "Dot", disabled = false, onSubmit, busy = false, approvalPending = false, completedTurn, streamError, onActivityChange }) {
  const voice = useHandsFreeVoice({ botId, onSubmit, busy, approvalPending, completedTurn, streamError, onActivityChange });
  const panelId = useId();
  const launchRef = useRef(null);
  const closeRef = useRef(null);
  const [minimized, setMinimized] = useState(false);

  useEffect(() => {
    if (voice.active) {
      setMinimized(false);
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
              const buttons = [...event.currentTarget.querySelectorAll("button:not(:disabled)")].filter(button => button.getClientRects().length);
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
            <div className="voice-identity"><FiHeadphones aria-hidden="true" /><strong>Voz con {botName}</strong></div>
            <button ref={closeRef} type="button" className="voice-close icon-button" aria-label="Cerrar modo voz y apagar el micrófono" onClick={close}><FiX aria-hidden="true" /></button>
          </div>
          <div className="voice-orb" aria-hidden="true"><span /><span /><span /><span /><span /></div>
          <p className="voice-status" role="status" aria-live="polite">{labels[voice.status] || labels.idle}</p>
          {voice.transcript && <p className="voice-transcript">{voice.transcript}</p>}
          {voice.error && <p className="voice-error" role="alert">{voice.error}</p>}
          {voice.status === "approval" && <p className="voice-approval-note">El micrófono está pausado. Revisa el destinatario y el texto, y pulsa <strong>Autorizar</strong> en la tarjeta del chat. La voz no aprueba acciones.</p>}
          <div className="voice-actions">
            {voice.status === "approval" && <button type="button" className="voice-primary" onClick={() => {
              setMinimized(true);
              const reviewButton = document.querySelector(".chat-action-reviews button");
              reviewButton?.scrollIntoView({ behavior: "smooth", block: "nearest" });
              reviewButton?.focus({ preventScroll: true });
            }}>Revisar en el chat</button>}
            {voice.status === "speaking" && <button type="button" className="voice-primary" onClick={voice.interrupt}><FiMic aria-hidden="true" />Interrumpir y hablar</button>}
            {voice.status === "listening" && voice.transcript && <button type="button" className="voice-primary" onClick={voice.sendNow}>Enviar ahora</button>}
            {voice.paused && voice.supported && <button type="button" className="voice-primary" onClick={voice.resume}><FiMic aria-hidden="true" />{voice.status === "error" ? "Reintentar voz" : "Retomar voz"}</button>}
            <button type="button" className="voice-secondary" onClick={close}><FiMicOff aria-hidden="true" />Volver a escribir</button>
          </div>
          <p className="voice-help">Habla y haz una pausa; enviaré tu frase y leeré la respuesta. Necesitas esta pantalla abierta. En iPhone, el micrófono y la voz dependen de Safari y sus permisos. El reconocimiento puede usar el servicio de voz de tu navegador.</p>
        </section>,
        document.body,
      )}
    </div>
  );
}
