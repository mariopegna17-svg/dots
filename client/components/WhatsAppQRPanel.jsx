"use client";
import { useEffect, useState } from "react";
import { FiCheck, FiMessageSquare, FiRefreshCw, FiLogOut } from "react-icons/fi";
import { agentState } from "../lib/api";

const states = {
  disconnected: "Sin conectar",
  connecting: "Preparando conexión…",
  qr: "Escanea el QR",
  connected: "WhatsApp conectado",
  reconnecting: "Recuperando conexión…",
  error: "La conexión necesita atención",
  unavailable: "WhatsApp no está disponible",
};

export default function WhatsAppQRPanel({ bots, onStatus }) {
  const [status, setStatus] = useState(null);
  const [draft, setDraft] = useState({ bot_id: bots[0]?.id || "", mode: "self", owner_phone_number: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  useEffect(() => {
    let disposed = false;
    let timer;
    let first = true;
    async function refresh() {
      try {
        const data = await agentState("communications/whatsapp-qr/status");
        if (disposed) return;
        setStatus(data);
        onStatus(data);
        if (first) {
          setDraft({ bot_id: data.bot_id || bots[0]?.id || "", mode: data.mode || "self", owner_phone_number: data.owner_phone_number || "" });
          first = false;
        }
      } catch (error) {
        if (!disposed) setNotice({ error: true, text: error.message });
      } finally {
        if (!disposed) timer = window.setTimeout(refresh, 2500);
      }
    }
    refresh();
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [bots, onStatus]);

  async function action(kind) {
    setBusy(true);
    setNotice(null);
    try {
      const data = await agentState(`communications/whatsapp-qr/${kind}`, "POST", kind === "disconnect" ? undefined : draft);
      setStatus(data);
      onStatus(data);
      setConfirmDisconnect(false);
      if (kind === "settings") setNotice({ text: "Guardado. El Dot elegido responderá a tus próximos mensajes." });
      if (kind === "disconnect") setNotice({ text: "Desconectado. El Dot ya no responderá por WhatsApp." });
    } catch (error) {
      setNotice({ error: true, text: error.message });
    } finally { setBusy(false); }
  }
  const connected = status?.state === "connected";
  const waiting = ["connecting", "reconnecting", "qr"].includes(status?.state);
  const changed = status && ["bot_id", "mode", "owner_phone_number"].some(key => draft[key] !== status[key]);
  const payloadValid = draft.bot_id && (draft.mode === "self" || /^\+[1-9][0-9]{6,14}$/.test(draft.owner_phone_number));
  return (
    <section className="whatsapp-qr-panel">
      <div className="whatsapp-qr-heading">
        <div className="whatsapp-qr-icon"><FiMessageSquare /></div>
        <div><h2>Tu Dot en WhatsApp</h2><p>Vincula con un QR y escríbele desde el móvil.</p></div>
        <span className={`whatsapp-state ${connected ? "is-connected" : ""}`} role="status">
          {connected ? <FiCheck /> : waiting ? <FiRefreshCw className="animate-spin" /> : null}
          {states[status?.state] || "Comprobando…"}
        </span>
      </div>
      {notice && <p role={notice.error ? "alert" : "status"} className={notice.error ? "inline-error" : "inline-success"}>{notice.text}</p>}
      {status?.error && <p role="alert" className="inline-error">{status.error}</p>}
      {status && !status.inference_ready && <p className="inline-error">Añade tu clave de NVIDIA en Ajustes para que el Dot pueda responder.</p>}
      <div className="whatsapp-qr-content">
        <div className="whatsapp-qr-settings">
          <label className="field-label">Dot que responde
            <select className="studio-input" aria-label="Dot que responde" value={draft.bot_id} disabled={busy} onChange={event => setDraft(previous => ({ ...previous, bot_id: event.target.value }))}>
              {bots.map(dot => <option key={dot.id} value={dot.id}>{dot.name}</option>)}
            </select>
          </label>
          <label className="field-label">Cómo quieres usarlo
            <select className="studio-input" aria-label="Cómo quieres usarlo" value={draft.mode} disabled={busy} onChange={event => setDraft(previous => ({ ...previous, mode: event.target.value, owner_phone_number: "" }))}>
              <option value="self">Mi WhatsApp · Mensaje a ti mismo</option>
              <option value="separate">Otro número para el Dot</option>
            </select>
          </label>
          {draft.mode === "separate" && <label className="field-label">Tu número habitual
            <input className="studio-input" aria-label="Tu número habitual" type="tel" placeholder="+34612345678" value={draft.owner_phone_number} disabled={busy} onChange={event => setDraft(previous => ({ ...previous, owner_phone_number: event.target.value }))} />
            <span className="muted">El Dot solo responderá a este número. Escanea el QR con el teléfono del Dot.</span>
          </label>}
          <p className="muted">{draft.mode === "self" ? "Escanea con tu móvil. Después abre tu propio chat en WhatsApp y escribe Hola. Los demás chats y grupos se ignoran." : "Escanea con el otro número. Después escríbele desde tu WhatsApp habitual."}</p>
          <div className="contact-send-row">
            {!connected && <button className="primary-button" disabled={busy || !status?.available || !payloadValid} onClick={() => action("connect")}>
              <FiMessageSquare /> {busy ? "Conectando…" : waiting ? "Renovar QR" : "Conectar WhatsApp"}
            </button>}
            {status?.enabled && changed && <button className="primary-button" disabled={busy || !payloadValid} onClick={() => action("settings")}>{busy ? "Guardando…" : "Guardar cambios"}</button>}
            {status?.enabled && <button className="compact-button" disabled={busy} onClick={() => setConfirmDisconnect(true)}><FiLogOut /> Desconectar</button>}
          </div>
          {confirmDisconnect && <div className="whatsapp-disconnect-confirm" role="alert">
            <p>¿Cerrar la sesión del Dot en WhatsApp? Para conectarlo otra vez tendrás que escanear el QR.</p>
            <div className="contact-send-row"><button className="compact-button" disabled={busy} onClick={() => setConfirmDisconnect(false)}>Cancelar</button><button className="primary-button" disabled={busy} onClick={() => action("disconnect")}>{busy ? "Desconectando…" : "Sí, desconectar"}</button></div>
          </div>}
        </div>
        <div className="whatsapp-qr-display">
          {status?.qr ? <>
            {/* QR is generated locally; never send it to a third-party image service. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={status.qr} alt="QR para vincular tu WhatsApp con Dots" width={320} height={320} />
            <p>El QR se renueva automáticamente.</p>
          </> : connected ? <div className="whatsapp-connected">
            <FiCheck /><strong>Listo para conversar</strong>
            {status.account_phone && <span>{status.account_phone}</span>}
            <p>{status.mode === "self" ? "Abre «Mensaje a ti mismo» y escribe Hola." : "Escribe a este número desde tu WhatsApp habitual."}</p>
            {status.mode === "separate" && status.account_phone && <a className="compact-button" href={`https://wa.me/${status.account_phone.replace(/\D/g, "")}`} target="_blank" rel="noopener noreferrer">Abrir conversación</a>}
          </div> : <div className="whatsapp-qr-placeholder"><FiMessageSquare /><p>{waiting ? "Esperando a WhatsApp…" : "Tu QR aparecerá aquí"}</p></div>}
        </div>
      </div>
      {!connected && <ol className="whatsapp-qr-steps"><li><strong>Conecta</strong><span>Elige un Dot y pulsa Conectar WhatsApp.</span></li><li><strong>Escanea</strong><span>WhatsApp → Ajustes o menú ⋮ → Dispositivos vinculados → Vincular un dispositivo.</span></li><li><strong>Conversa</strong><span>Envía un mensaje de texto y tu Dot responderá en el mismo chat.</span></li></ol>}
      <p className="whatsapp-qr-footnote">Sin Twilio ni coste por mensaje del conector. Usa tu API de NVIDIA. Conexión no oficial: WhatsApp puede desconectarla o bloquear la cuenta. En Render gratis, abre la web para despertar el servicio; puede pedirte otro QR tras un reinicio.</p>
    </section>
  );
}
