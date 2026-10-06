"use client";
import { useState } from "react";
import { FiArrowUpRight, FiCheck, FiX } from "react-icons/fi";
import Modal from "./Modal";
import MascotAvatar from "./MascotAvatar";

const tones = ["lime", "orange", "mint", "lavender", "blue", "pink"];
export default function CreateDotDialog({ defaultModel, onCreate, onClose }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [tone, setTone] = useState("lime");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onCreate({
        name: name.trim(),
        role: role.trim() || "Asistente personal",
        description:
          role.trim() || "Un nuevo compañero para tus ideas y tareas.",
        accent_color: tone,
        avatar: "✦",
        model: defaultModel,
        system_prompt: `Eres ${name.trim()}, un asistente personal. ${role.trim() ? `Tu especialidad es: ${role.trim()}.` : ""} Responde en español y ayuda de forma clara y útil.`,
      });
      onClose();
    } catch (failure) {
      setError(failure.message || "No se pudo crear el Dot.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      onClose={onClose}
      titleId="create-dot-title"
      className="create-dot-dialog"
    >
      <div className="dialog-header">
        <span className="eyebrow">UN NUEVO COMIENZO</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Cerrar creación de Dot"
        >
          <FiX />
        </button>
      </div>
      <div className={`create-preview tone-${tone}`}>
        <MascotAvatar type={tone} size="hero" />
        <span className="create-preview-orbit" />
      </div>
      <h2 id="create-dot-title" className="dialog-title">
        Dale vida a tu Dot.
      </h2>
      <p className="muted">
        Un nombre, una especialidad y su propia personalidad.
      </p>
      <form onSubmit={submit} className="create-form">
        <label className="field-label">
          ¿Cómo se llama?
          <input
            autoFocus
            className="studio-input"
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Por ejemplo, Atlas"
          />
        </label>
        <label className="field-label">
          ¿En qué te ayudará?
          <textarea
            className="studio-input"
            rows={2}
            maxLength={1000}
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Organizar mis ideas, escribir o aprender algo nuevo…"
          />
        </label>
        <fieldset>
          <legend className="field-label">Elige su color</legend>
          <div className="color-options">
            {tones.map((color) => (
              <button
                key={color}
                type="button"
                aria-label={`Color ${color}`}
                aria-pressed={tone === color}
                onClick={() => setTone(color)}
                className={`color-option tone-${color} ${tone === color ? "selected" : ""}`}
              >
                <span />
                {tone === color && <FiCheck />}
              </button>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="primary-button full-width"
        >
          {busy ? "Creando tu Dot…" : "Crear mi Dot"}
          <FiArrowUpRight />
        </button>
      </form>
    </Modal>
  );
}
