"use client";
import { useEffect, useRef, useState } from "react";
import { FiCheck, FiMoon, FiSun } from "react-icons/fi";
import { applyAppearance, DEFAULT_APPEARANCE, normalizeAppearance, savedAppearance } from "../lib/appearance";
import { fetchSettings, saveSettings } from "../lib/api";

const THEMES = [{ id: "dark", label: "Cristal", detail: "Azul suave", Icon: FiMoon }, { id: "light", label: "Luz", detail: "Cristal claro", Icon: FiSun }, { id: "aurora", label: "Aurora", detail: "Violeta y menta", Icon: FiMoon }, { id: "midnight", label: "Medianoche", detail: "Negro profundo", Icon: FiMoon }];
const ACCENTS = { blue: "Azul", mint: "Menta", violet: "Violeta", rose: "Rosa" };
export default function AppearancePanel() {
  const [appearance, setAppearance] = useState(savedAppearance);
  const saved = useRef(savedAppearance());
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    fetchSettings().then((data) => {
      if (disposed) return;
      if (!data) { setError("No se pudo cargar la apariencia guardada."); return; }
      const next = normalizeAppearance(data); saved.current = next; setAppearance(next); applyAppearance(next, true); setLoaded(true);
    });
    return () => { disposed = true; applyAppearance(saved.current); };
  }, []);
  function choose(key, value) {
    const next = { ...appearance, [key]: value }; setAppearance(next); applyAppearance(next); setNotice(""); setError("");
  }
  async function save(event) {
    event.preventDefault(); setBusy(true); setNotice(""); setError("");
    try { const data = await saveSettings(appearance); if (!data) throw new Error("No se pudo guardar la apariencia."); saved.current = normalizeAppearance(data); applyAppearance(saved.current, true); setNotice("Tu apariencia se ha guardado."); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  return <form className="settings-card appearance-panel" onSubmit={save}><h3>Apariencia</h3><p>Elige el cristal, el color y el movimiento de tu espacio.</p>
    <fieldset disabled={!loaded || busy}><legend className="sr-only">Tema</legend><div className="theme-grid">{THEMES.map(({ id, label, detail, Icon }) => <button key={id} type="button" className={`theme-choice theme-preview-${id}`} aria-pressed={appearance.theme === id} onClick={() => choose("theme", id)}><span className="theme-preview"><Icon />{appearance.theme === id && <FiCheck />}</span><strong>{label}</strong><small>{detail}</small></button>)}</div>
      <div className="accent-choices" role="group" aria-label="Color de acento">{Object.entries(ACCENTS).map(([id, label]) => <button key={id} type="button" data-color={id} className="accent-choice" aria-pressed={appearance.theme_accent === id} aria-label={label} title={label} onClick={() => choose("theme_accent", id)}>{appearance.theme_accent === id && <FiCheck />}</button>)}</div>
      <label className="appearance-option">Espaciado<select aria-label="Espaciado" value={appearance.theme_density} onChange={(e) => choose("theme_density", e.target.value)}><option value="comfortable">Cómodo</option><option value="compact">Compacto</option></select></label>
      <label className="appearance-toggle"><input type="checkbox" checked={appearance.theme_motion === "full"} onChange={(e) => choose("theme_motion", e.target.checked ? "full" : "reduced")} /> Animaciones y reflejos</label>
      <small>Se respeta también la opción Reducir movimiento de tu dispositivo.</small>
      <div className="appearance-buttons"><button className="text-button" type="button" onClick={() => { setAppearance(DEFAULT_APPEARANCE); applyAppearance(DEFAULT_APPEARANCE); setNotice(""); }}>Restaurar</button><button className="primary-button" type="submit">{busy ? "Guardando…" : "Guardar apariencia"}</button></div>
    </fieldset>{(notice || error) && <p role={error ? "alert" : "status"} className={error ? "message-error" : "muted"}>{error || notice}</p>}
  </form>;
}
