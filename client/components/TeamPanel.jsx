"use client";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { FiCheck, FiCopy, FiSquare, FiUsers } from "react-icons/fi";
import MascotAvatar, { botTone } from "./MascotAvatar";
import { cancelTeamRun, createTeamRun, fetchTeamRun, fetchTeamRuns, fetchSettings, saveSettings } from "../lib/api";

const PHASES = { queued: "Esperando turno", analysis: "Cada Dot está aportando su solución", review: "Los Dots están revisando sus ideas juntos", synthesis: "El coordinador está preparando tu resultado", finished: "Trabajo terminado" };
const STATES = { waiting: "En espera", thinking: "Pensando…", analyzed: "Primera aportación lista", reviewing: "Revisando a sus compañeros…", done: "Aportación y revisión listas", failed: "No pudo completar su aportación", review_failed: "Primera aportación disponible" };
const ACTIVE = new Set(["queued", "running"]);
function Markdown({ children }) { return <ReactMarkdown components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{children}</ReactMarkdown>; }

export default function TeamPanel({ bots, providerConfigured, onOpenSettings }) {
  const [selected, setSelected] = useState(() => bots.slice(0, 3).map((b) => b.id));
  const [coordinator, setCoordinator] = useState(bots[0]?.id || "");
  const [prompt, setPrompt] = useState("");
  const [run, setRun] = useState(null);
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  useEffect(() => {
    let disposed = false;
    setPreferencesLoaded(false);
    fetchSettings().then((settings) => {
      if (disposed) return;
      if (!settings) { setError("No se pudo cargar el equipo guardado."); return; }
      const ids = (settings?.team_bot_ids || []).filter((id) => bots.some((bot) => bot.id === id));
      if (ids.length) { setSelected(ids); setCoordinator(ids.includes(settings.team_coordinator_id) ? settings.team_coordinator_id : ids[0]); }
      setPreferencesLoaded(true);
    });
    return () => { disposed = true; };
  }, [bots]);
  useEffect(() => {
    if (!preferencesLoaded) return;
    const timer = setTimeout(() => {
      saveSettings({ team_bot_ids: selected, team_coordinator_id: coordinator }).catch(() => setError("No se pudo guardar la composición del equipo. Comprueba la conexión."));
    }, 600);
    return () => clearTimeout(timer);
  }, [selected, coordinator, preferencesLoaded]);
  useEffect(() => {
    let disposed = false;
    fetchTeamRuns().then(({ runs }) => { if (!disposed) { setHistory(runs); setRun(runs[0] || null); } }).catch((failure) => { if (!disposed) setError(failure.message); });
    return () => { disposed = true; };
  }, []);
  const runId = run?.id;
  const active = ACTIVE.has(run?.status);
  useEffect(() => {
    if (!runId || !active) return;
    let disposed = false;
    let timer;
    async function poll() {
      try {
        const next = await fetchTeamRun(runId);
        if (disposed) return;
        setRun(next); setHistory((items) => [next, ...items.filter((i) => i.id !== next.id)]);
        if (!ACTIVE.has(next.status)) return;
      } catch (failure) { if (!disposed) setError(failure.message); }
      if (!disposed) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 1000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [runId, active]);
  function toggle(id) {
    const next = selected.includes(id) ? selected.filter((value) => value !== id) : selected.length < 4 ? [...selected, id] : selected;
    setSelected(next);
    if (!next.includes(coordinator)) setCoordinator(next[0] || "");
  }
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError(""); setCopied(false);
    try {
      const next = await createTeamRun({ prompt, bot_ids: selected, coordinator_id: coordinator });
      setRun(next); setHistory((items) => [next, ...items]);
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function stop() {
    setBusy(true);
    try { const next = await cancelTeamRun(run.id); setRun(next); setHistory((items) => items.map((i) => i.id === next.id ? next : i)); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(run.result); setCopied(true); } catch { setError("No se pudo copiar el resultado. Puedes seleccionarlo y copiarlo manualmente."); }
  }
  return <section className="state-panel"><div className="team-inner">
    <header className="state-heading"><div><span className="eyebrow">PIENSAN JUNTOS PARA TI</span><h1>Tu equipo de Dots</h1><p>Elige a tus Dots. Comparten ideas, las revisan y te entregan un resultado final.</p></div><FiUsers className="team-heading-icon" /></header>
    {!providerConfigured && <div className="connector-notice"><p>Configura tu proveedor de IA para que el equipo pueda trabajar.</p><button className="text-button" onClick={onOpenSettings}>Configurar IA</button></div>}
    {error && <p role="alert" className="message-error team-feedback">{error}</p>}
    <form className="team-form" onSubmit={submit}>
      <div className="team-form-label"><h2>¿Quiénes van a colaborar?</h2><span>De 2 a 4 Dots</span></div>
      <div className="team-pick-grid">{bots.map((bot) => <label key={bot.id} className={`team-pick ${selected.includes(bot.id) ? "is-selected" : ""}`}><input type="checkbox" checked={selected.includes(bot.id)} onChange={() => toggle(bot.id)} disabled={busy || active || (!selected.includes(bot.id) && selected.length >= 4)} /><MascotAvatar type={botTone(bot)} size="md" /><span><strong>{bot.name}</strong><small>{bot.role}</small></span>{selected.includes(bot.id) && <FiCheck />}</label>)}</div>
      {bots.length < 2 && <p className="muted">Crea al menos dos Dots desde Inicio para formar un equipo.</p>}
      <label className="team-coordinator">Coordinador<select aria-label="Coordinador" value={coordinator} disabled={busy || active} onChange={(e) => setCoordinator(e.target.value)}>{bots.filter((b) => selected.includes(b.id)).map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select><small>Combina las aportaciones y redacta la respuesta final.</small></label>
      <label className="team-task-label" htmlFor="team-task">¿Qué quieres resolver?</label><textarea id="team-task" required rows={4} maxLength={12000} value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={busy || active} placeholder="Por ejemplo: preparad un plan para mi canal de YouTube, revisad las ideas y dadme una propuesta final." />
      <footer><p>Cada Dot usa tu proveedor de IA. Las aportaciones y revisiones quedan visibles aquí.</p><button className="primary-button" type="submit" disabled={busy || active || selected.length < 2 || !prompt.trim() || !providerConfigured}><FiUsers />{busy ? "Preparando…" : active ? "Equipo trabajando…" : "Trabajar juntos"}</button></footer>
    </form>
    {run && <section className="team-run" aria-label="Trabajo del equipo">
      <header><div><span className="eyebrow">{run.status === "completed" ? "RESULTADO LISTO" : run.status === "partial" ? "RESULTADO CON APORTACIONES INCOMPLETAS" : "TRABAJO COMPARTIDO"}</span><h2>{PHASES[run.phase]}</h2></div>{active && <button className="compact-button" onClick={stop} disabled={busy}><FiSquare /> Cancelar tarea</button>}</header>
      <p className="team-run-prompt">{run.prompt}</p>
      <ol className="team-steps">{["analysis", "review", "synthesis"].map((phase, index) => <li key={phase} className={run.phase === phase ? "current" : run.phase === "finished" && ["completed", "partial"].includes(run.status) ? "done" : ""}><span>{index + 1}</span>{["Aportan", "Revisan juntos", "Resultado final"][index]}</li>)}</ol>
      <div className="team-contributions">{run.members.map((member) => <article key={member.bot_id}><header><MascotAvatar type={botTone(member)} size="md" activity={["thinking", "reviewing"].includes(member.status) && active ? "thinking" : "idle"} /><div><strong>{member.name}{member.bot_id === run.coordinator_id ? " · coordinador" : ""}</strong><small>{STATES[member.status]}</small></div></header>{member.error && <p className="message-error">{member.error}</p>}{member.analysis && <details><summary>Ver aportación</summary><div className="team-markdown"><Markdown>{member.analysis}</Markdown></div></details>}{member.review && <details><summary>Ver revisión del equipo</summary><div className="team-markdown"><Markdown>{member.review}</Markdown></div></details>}</article>)}</div>
      {run.error && <p role="alert" className="message-error team-feedback">{run.error}</p>}
      {run.result && <article className="team-result"><header><h3>Tu resultado final</h3><button className="text-button" onClick={copy}><FiCopy />{copied ? "Copiado" : "Copiar resultado"}</button></header>{run.status === "partial" && <p className="muted">Alguna aportación o revisión no se completó. El coordinador ha trabajado con las respuestas disponibles.</p>}<div className="team-markdown"><Markdown>{run.result}</Markdown></div></article>}
    </section>}
    {history.length > 1 && <section className="team-history"><h2>Trabajos anteriores</h2>{history.filter((i) => i.id !== run?.id).slice(0, 8).map((item) => <button key={item.id} onClick={() => { setRun(item); setCopied(false); }}><span>{item.prompt}</span><small>{ACTIVE.has(item.status) ? "En marcha" : item.status === "completed" ? "Terminado" : item.status === "partial" ? "Parcial" : "Sin completar"}</small></button>)}</section>}
  </div></section>;
}
