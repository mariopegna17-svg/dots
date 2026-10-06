"use client";
import { useState } from "react";
import { FiShield, FiPhone, FiCheck, FiX } from "react-icons/fi";
export default function ApprovalCard({ approval, onRespond }) {
  const [status, setStatus] = useState("pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const communication = approval.tool?.startsWith("communication");
  async function decide(action) {
    setBusy(true);
    setError("");
    try {
      await onRespond(approval.requestId, action);
      setStatus(action === "allow" ? "allowed" : "denied");
    } catch (failure) {
      setError(failure.message || "No se pudo guardar tu decisión.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="action-review" aria-label="Revisar acción del Dot">
      <header>
        {communication ? <FiPhone /> : <FiShield />}
        <strong>Revisa esta acción</strong>
      </header>
      <p>{approval.summary}</p>
      <small>
        {communication
          ? "Se usará tu cuenta de Twilio y puede tener coste."
          : "Tu Dot te pide permiso para realizar esta acción."}
      </small>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {status === "pending" ? (
        <footer>
          <button
            className="compact-button"
            disabled={busy || !onRespond}
            onClick={() => decide("deny")}
          >
            <FiX /> Rechazar
          </button>
          <button
            className="primary-button"
            disabled={busy || !onRespond}
            onClick={() => decide("allow")}
          >
            <FiCheck /> {busy ? "Guardando…" : "Autorizar"}
          </button>
        </footer>
      ) : (
        <div className="action-decision" role="status">
          {status === "allowed" ? <FiCheck /> : <FiX />}
          {status === "allowed" ? "Acción autorizada" : "Acción rechazada"}
        </div>
      )}
    </section>
  );
}
