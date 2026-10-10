"use client";
import { useEffect, useRef, useState } from "react";
import {
  FiPhone,
  FiMessageSquare,
  FiSettings,
  FiCopy,
  FiArrowUpRight,
  FiCheck,
  FiRefreshCw,
} from "react-icons/fi";
import { agentState } from "../lib/api";
import Modal from "./Modal";
import WhatsAppQRPanel from "./WhatsAppQRPanel";

const labels = {
  pending: "En preparación",
  submitted: "Aceptado por Twilio",
  failed: "No se pudo completar",
  completed: "Completado",
  queued: "En cola",
  initiated: "Iniciando llamada",
  ringing: "Tu teléfono está sonando",
  "in-progress": "Llamada en curso",
  busy: "Teléfono ocupado",
  "no-answer": "No se ha contestado",
  canceled: "Cancelado",
  accepted: "Aceptado por Twilio",
  sending: "Enviando",
  sent: "Enviado; pendiente de entrega",
  delivered: "Entregado",
  read: "Leído",
  undelivered: "No entregado",
};
const fields = [
  ["owner_phone_number", "Tu número", "+34612345678", "tel"],
  [
    "twilio_voice_number",
    "Número de Twilio para llamadas",
    "+12025550123",
    "tel",
  ],
  [
    "twilio_whatsapp_number",
    "Número de WhatsApp de Twilio",
    "+14155238886",
    "tel",
  ],
  ["twilio_account_sid", "Account SID", "AC…", "text"],
  [
    "communication_public_url",
    "URL pública de esta web",
    "https://tu-app.onrender.com",
    "url",
  ],
];

export default function ContactPanel({ bots, bot }) {
  const [config, setConfig] = useState(null);
  const [events, setEvents] = useState([]);
  const [channel, setChannel] = useState("whatsapp");
  const [whatsappProvider, setWhatsappProvider] = useState("qr");
  const [qrStatus, setQRStatus] = useState(null);
  const showTwilio = channel === "voice" || whatsappProvider === "twilio";
  const [message, setMessage] = useState("");
  const [selectedBot, setSelectedBot] = useState(bot?.id || "");
  const [setupOpen, setSetupOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState(null);
  const [diagnostic, setDiagnostic] = useState(null);
  const [checking, setChecking] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [whatsappSendMode, setWhatsappSendMode] = useState("review");
  const preparingSend = useRef(false);
  const sending = useRef(false);
  const configLoaded = Boolean(config);
  useEffect(() => {
    let disposed = false;
    agentState("settings").then((data) => {
      if (!disposed) setWhatsappSendMode(data.whatsapp_send_mode || "automatic");
    }).catch(() => {
      if (!disposed) setWhatsappSendMode("review");
    });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    let disposed = false;
    Promise.all([
      agentState("communications/settings"),
      agentState("communications/events"),
    ])
      .then(([data, history]) => {
        if (disposed) return;
        setConfig({
          ...data,
          communication_bot_id:
            data.communication_bot_id || bot?.id || bots[0]?.id || "",
        });
        setSelectedBot(
          data.communication_bot_id || bot?.id || bots[0]?.id || "",
        );
        setEvents(history);
      })
      .catch(
        (error) => !disposed && setNotice({ error: true, text: error.message }),
      );
    return () => {
      disposed = true;
    };
  }, [bot?.id, bots]);
  useEffect(() => {
    if (!configLoaded) return;
    let disposed = false;
    const timer = window.setInterval(async () => {
      try {
        const history = await agentState("communications/events");
        if (!disposed) {
          setEvents(history);
          setHistoryError("");
        }
      } catch {
        if (!disposed)
          setHistoryError(
            "No se ha podido actualizar el estado. Comprueba tu conexión.",
          );
      }
    }, 4000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [configLoaded]);
  function openSetup() {
    setDraft({
      ...config,
      communication_public_url:
        config.communication_public_url ||
        (window.location.protocol === "https:" ? window.location.origin : ""),
    });
    setSetupOpen(true);
  }
  async function checkConnection() {
    setChecking(true);
    setNotice(null);
    try {
      setDiagnostic(await agentState("communications/check", "POST"));
    } catch (error) {
      setNotice({ error: true, text: error.message });
    } finally {
      setChecking(false);
    }
  }
  async function save(event) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const payload = Object.fromEntries(
        [
          "communications_enabled",
          "twilio_account_sid",
          "twilio_auth_token",
          "owner_phone_number",
          "twilio_voice_number",
          "twilio_whatsapp_number",
          "communication_bot_id",
          "communication_public_url",
        ].map((key) => [key, draft[key]]),
      );
      const data = await agentState("communications/settings", "POST", payload);
      setConfig(data);
      setDiagnostic(null);
      setSetupOpen(false);
      setNotice({
        text:
          data.voice_ready || data.whatsapp_ready
            ? "Conexión guardada. Twilio debe estar configurado también en su panel."
            : "Ajustes guardados. Completa los datos para activar la conexión.",
      });
    } catch (error) {
      setNotice({ error: true, text: error.message });
    } finally {
      setBusy(false);
    }
  }
  async function requestSend() {
    if (busy || preparingSend.current || sending.current) return;
    if (channel === "voice") {
      setConfirm(true);
      return;
    }
    preparingSend.current = true;
    setBusy(true);
    setNotice(null);
    try {
      // Read again on the click so a changed preference takes effect immediately.
      const data = await agentState("settings");
      const mode = data.whatsapp_send_mode || "automatic";
      setWhatsappSendMode(mode);
      if (mode === "automatic") await send();
      else setConfirm(true);
    } catch {
      setWhatsappSendMode("review");
      setNotice({ error: true, text: "No se pudo comprobar tu preferencia de envío. No se ha enviado el mensaje; vuelve a intentarlo." });
    } finally {
      preparingSend.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await agentState(
        `communications/${channel === "voice" ? "call" : "whatsapp"}`,
        "POST",
        { bot_id: selectedBot, message },
      );
      setConfirm(false);
      setMessage("");
      setNotice({
        text:
          channel === "voice"
            ? "Twilio ha aceptado la llamada a tu número."
            : "Twilio ha aceptado el mensaje. Comprueba la entrega en Últimas comunicaciones.",
      });
    } catch (error) {
      setConfirm(false);
      setNotice({ error: true, text: error.message });
    } finally {
      try {
        setEvents(await agentState("communications/events"));
      } catch {
        setHistoryError(
          "No se ha podido actualizar el estado. Comprueba tu conexión.",
        );
      }
      setBusy(false);
      sending.current = false;
    }
  }
  const ready = Boolean(
    config?.[channel === "voice" ? "voice_ready" : "whatsapp_ready"],
  );
  const update = (key, value) =>
    setDraft((previous) => ({ ...previous, [key]: value }));
  return (
    <div className="contact-scroll">
      <div className="contact-inner">
        <header className="contact-heading">
          <div>
            <h1>Llamadas y WhatsApp</h1>
            <p>Habla con tu Dot también desde tu teléfono.</p>
          </div>
          {showTwilio && <div className="contact-actions">
            <button
              className="compact-button"
              disabled={!config || busy || checking}
              onClick={checkConnection}
            >
              <FiRefreshCw className={checking ? "animate-spin" : ""} />
              {checking ? "Comprobando…" : "Comprobar conexión"}
            </button>
            <button
              className="compact-button"
              disabled={!config || busy || checking}
              onClick={openSetup}
            >
              <FiSettings /> Configurar
            </button>
          </div>}
        </header>
        {notice && (
          <p
            role={notice.error ? "alert" : "status"}
            className={notice.error ? "inline-error" : "inline-success"}
          >
            {notice.text}
          </p>
        )}
        {showTwilio && diagnostic && (
          <section className="contact-diagnostic" aria-live="polite">
            <h2>
              {diagnostic.ok
                ? "Comprobaciones correctas"
                : "Hay problemas en la conexión"}
            </h2>
            <ul>
              {diagnostic.checks.map((check) => (
                <li
                  key={check.id}
                  className={check.ok ? "inline-success" : "inline-error"}
                >
                  {check.ok ? "✓" : "×"} {check.message}
                </li>
              ))}
            </ul>
            <p className="muted">{diagnostic.whatsapp_note}</p>
            <button
              className="text-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(
                    [
                      "Diagnóstico de Dots",
                      ...diagnostic.checks.map(
                        (check) =>
                          `${check.ok ? "OK" : "ERROR"}: ${check.message}`,
                      ),
                      diagnostic.whatsapp_note,
                    ].join("\n"),
                  );
                  setNotice({
                    text: "Diagnóstico copiado. No contiene tus credenciales.",
                  });
                } catch {
                  setNotice({
                    error: true,
                    text: "Selecciona y copia el diagnóstico manualmente.",
                  });
                }
              }}
            >
              <FiCopy /> Copiar diagnóstico
            </button>
          </section>
        )}
        <div className="contact-channels">
          {[
            [
              "voice",
              FiPhone,
              "Llamadas",
              "Tu Dot te llama y puedes responderle con la voz.",
            ],
            [
              "whatsapp",
              FiMessageSquare,
              "WhatsApp",
              "Escríbele a tu Dot y recibe su respuesta en WhatsApp.",
            ],
          ].map(([id, Icon, title, text]) => (
            <button
              key={id}
              className={`contact-channel ${channel === id ? "selected" : ""}`}
              aria-pressed={channel === id}
              onClick={() => setChannel(id)}
            >
              <Icon />
              <strong>{title}</strong>
              <p>{text}</p>
              <span
                className={
                  (id === "whatsapp" && whatsappProvider === "qr" ? qrStatus?.state === "connected" : config?.[id === "voice" ? "voice_ready" : "whatsapp_ready"])
                    ? "channel-ready"
                    : "muted"
                }
              >
                {(id === "whatsapp" && whatsappProvider === "qr" ? qrStatus?.state === "connected" : config?.[id === "voice" ? "voice_ready" : "whatsapp_ready"])
                  ? (id === "whatsapp" && whatsappProvider === "qr" ? "Conectado" : "Datos configurados")
                  : "Por conectar"}
              </span>
            </button>
          ))}
        </div>
        {channel === "whatsapp" && <div className="whatsapp-provider-options">
          <button className={`compact-button ${whatsappProvider === "qr" ? "selected" : ""}`} aria-pressed={whatsappProvider === "qr"} onClick={() => setWhatsappProvider("qr")}>Con QR · sencillo</button>
          <button className={`text-button ${whatsappProvider === "twilio" ? "selected" : ""}`} aria-pressed={whatsappProvider === "twilio"} onClick={() => setWhatsappProvider("twilio")}>Usar Twilio</button>
        </div>}
        {channel === "whatsapp" && whatsappProvider === "qr" && <WhatsAppQRPanel bots={bots} onStatus={setQRStatus} />}
        {showTwilio && <>
        <section className="contact-compose">
          <h2>
            {channel === "voice" ? "Pedir una llamada" : "Enviar un WhatsApp"}
          </h2>
          <p className="muted">
            Se enviará únicamente a tu número configurado. Twilio puede cobrar
            por el uso.
          </p>
          <label className="field-label">
            Dot
            <select
              className="studio-input"
              value={selectedBot}
              onChange={(e) => setSelectedBot(e.target.value)}
            >
              {bots.map((dot) => (
                <option key={dot.id} value={dot.id}>
                  {dot.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {channel === "voice"
              ? "Mensaje con el que empezará la llamada"
              : "Mensaje"}
            <textarea
              className="studio-input"
              aria-label={
                channel === "voice"
                  ? "Mensaje con el que empezará la llamada"
                  : "Mensaje"
              }
              rows={3}
              maxLength={1500}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                channel === "voice"
                  ? "Hola, vamos a repasar tus planes para hoy."
                  : "Aquí tienes el resumen de hoy…"
              }
            />
          </label>
          <div className="contact-send-row">
            <button
              className="primary-button"
              disabled={!ready || !message.trim() || !selectedBot || busy}
              onClick={requestSend}
            >
              {channel === "voice" ? <FiPhone /> : <FiMessageSquare />}
              {busy ? "Enviando…" : channel === "voice" ? "Llamarme" : whatsappSendMode === "automatic" ? "Enviar WhatsApp" : "Revisar envío"}
            </button>
            {!ready && (
              <button
                className="text-button"
                disabled={!config}
                onClick={openSetup}
              >
                Conectar con Twilio <FiArrowUpRight />
              </button>
            )}
          </div>
          {!ready && config?.setup_issues?.[channel]?.length > 0 && (
            <ul className="contact-setup-issues">
              {config.setup_issues[channel].map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </section>
        <section className="contact-guide">
          <h2>Conecta tu teléfono</h2>
          <p>
            Necesitas una cuenta de Twilio, un número para llamadas y el Sandbox
            de WhatsApp o un remitente aprobado. NVIDIA genera las respuestas;
            Twilio gestiona la voz y los mensajes.
          </p>
          <p>
            En el Sandbox, envía el código <code>join</code> que te muestra
            Twilio desde tu WhatsApp. Después configura este webhook, por{" "}
            <strong>POST</strong>, en “When a message comes in”:
          </p>
          <div className="webhook-field">
            <code>
              {config?.whatsapp_webhook ||
                "Añade la URL pública de tu web en Configurar."}
            </code>
            <button
              className="icon-button"
              disabled={!config?.whatsapp_webhook}
              aria-label="Copiar webhook de WhatsApp"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(config.whatsapp_webhook);
                  setCopied(true);
                } catch {
                  setNotice({
                    error: true,
                    text: "Selecciona y copia la URL manualmente.",
                  });
                }
              }}
            >
              {copied ? <FiCheck /> : <FiCopy />}
            </button>
          </div>
          <p>
            Los mensajes libres de WhatsApp requieren una conversación abierta
            en las últimas 24 horas. Las llamadas duran hasta 3 minutos. Los
            canales solo admiten tu número; desde el teléfono puedes conversar,
            y las acciones se aprueban en la web.
          </p>
          <a
            href="https://www.twilio.com/docs/whatsapp/sandbox"
            target="_blank"
            rel="noopener noreferrer"
            className="text-button"
          >
            Abrir la guía de Twilio <FiArrowUpRight />
          </a>
          <details>
            <summary>Conservar la conexión en Render Free</summary>
            <p>
              Render Free puede borrar los ajustes guardados en la web al
              desplegar o reiniciar. Guarda estos valores en Render →
              Environment para que la conexión se recupere automáticamente:
            </p>
            <pre className="contact-env-vars">
              {
                "COMMUNICATIONS_ENABLED=1\nTWILIO_ACCOUNT_SID\nTWILIO_AUTH_TOKEN\nOWNER_PHONE_NUMBER\nTWILIO_VOICE_NUMBER\nTWILIO_WHATSAPP_NUMBER"
              }
            </pre>
            <p>Render proporciona la URL pública automáticamente.</p>
          </details>
        </section>
        </>}
        {events.length > 0 && (
        <section className="contact-history">
            <h2>Últimas comunicaciones</h2>
            {events.map((event) => (
              <article key={event.id}>
                <span>
                  {event.channel === "voice_out" ? (
                    <FiPhone />
                  ) : (
                    <FiMessageSquare />
                  )}
                </span>
                <div>
                  <strong>
                    {event.channel === "voice_out"
                      ? "Llamada"
                      : event.channel === "whatsapp_in"
                        ? "WhatsApp recibido"
                        : "WhatsApp enviado"}
                  </strong>
                  <p>{event.message}</p>
                  {event.reply && <p>{event.reply}</p>}
                  {event.error && <p className="inline-error">{event.error}</p>}
                  <small>
                    {event.provider === "qr" && event.status === "sent" ? "Respuesta enviada por WhatsApp" : labels[event.status] || event.status} ·{" "}
                    {new Date(event.created_at).toLocaleString("es-ES")}
                  </small>
                </div>
              </article>
            ))}
          </section>
        )}
        {historyError && (
          <p className="inline-error" role="status">
            {historyError}
          </p>
        )}
        {setupOpen && draft && (
          <Modal
            onClose={() => !busy && setSetupOpen(false)}
            titleId="contact-settings-title"
            className="contact-modal"
          >
            <form onSubmit={save}>
              <header className="modal-heading">
                <div>
                  <h2 id="contact-settings-title">Conectar mi teléfono</h2>
                  <p>Credenciales privadas de tu cuenta de Twilio.</p>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Cerrar configuración"
                  disabled={busy}
                  onClick={() => setSetupOpen(false)}
                >
                  ×
                </button>
              </header>
              <div className="contact-form-grid">
                {fields.map(([key, label, placeholder, type]) => (
                  <label className="field-label" key={key}>
                    {label}
                    <input
                      className="studio-input"
                      type={type}
                      value={draft[key] || ""}
                      placeholder={placeholder}
                      onChange={(e) => update(key, e.target.value)}
                    />
                  </label>
                ))}
                <label className="field-label">
                  Auth Token de Twilio
                  <input
                    className="studio-input"
                    type="password"
                    autoComplete="new-password"
                    value={draft.twilio_auth_token || ""}
                    placeholder={
                      draft.twilio_auth_token_configured
                        ? "Guardado; deja vacío para conservarlo"
                        : "Pega el Auth Token de Twilio"
                    }
                    onChange={(e) =>
                      update("twilio_auth_token", e.target.value)
                    }
                  />
                </label>
                <label className="field-label">
                  Dot que responde por WhatsApp
                  <select
                    className="studio-input"
                    value={draft.communication_bot_id}
                    onChange={(e) =>
                      update("communication_bot_id", e.target.value)
                    }
                  >
                    {bots.map((dot) => (
                      <option key={dot.id} value={dot.id}>
                        {dot.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="contact-enable">
                <input
                  type="checkbox"
                  checked={Boolean(draft.communications_enabled)}
                  onChange={(e) =>
                    update("communications_enabled", e.target.checked)
                  }
                />{" "}
                Activar llamadas y WhatsApp para mi número
              </label>
              {notice?.error && (
                <p role="alert" className="inline-error">
                  {notice.text}
                </p>
              )}
              <p className="muted">
                Usa Account SID y Auth Token de Account Info en Twilio Console.
                Una cuenta Trial sirve; las Test Credentials de la API simulan
                solicitudes y no realizan llamadas ni entregan mensajes.
              </p>
              <p className="muted">
                El token se guarda cifrado y nunca se devuelve al navegador. La
                cuenta de prueba tiene crédito limitado; comprueba las tarifas y
                la verificación de tu número en Twilio.
              </p>
              <button className="primary-button" disabled={busy}>
                {busy ? "Guardando…" : "Guardar conexión"}
              </button>
            </form>
          </Modal>
        )}
        {confirm && (
          <Modal
            onClose={() => !busy && setConfirm(false)}
            titleId="contact-confirm-title"
            className="contact-confirm"
          >
            <h2 id="contact-confirm-title">
              {channel === "voice" ? "Confirmar llamada" : "Confirmar WhatsApp"}
            </h2>
            <p>
              Destino: <strong>{config.owner_phone_number}</strong>
            </p>
            <blockquote>{message}</blockquote>
            <p className="muted">
              Se realizará a través de tu cuenta de Twilio y puede tener coste.
            </p>
            <div className="contact-send-row">
              <button
                className="compact-button"
                disabled={busy}
                onClick={() => setConfirm(false)}
              >
                Cancelar
              </button>
              <button className="primary-button" disabled={busy} onClick={send}>
                {busy
                  ? "Enviando…"
                  : channel === "voice"
                    ? "Confirmar y llamarme"
                    : "Confirmar y enviar"}
              </button>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}
