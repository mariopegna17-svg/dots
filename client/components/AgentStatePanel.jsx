"use client";
import { useCallback, useEffect, useState } from "react";
import {
  FiClock,
  FiPlus,
  FiTrash2,
  FiPlay,
  FiPause,
  FiBookOpen,
} from "react-icons/fi";
import { agentState } from "../lib/api";

const input = "studio-input";
const button = "primary-button";
const labels = {
  queued: "Programada",
  running: "Trabajando",
  paused: "En pausa",
  completed: "Completada",
  failed: "Error",
};

export default function AgentStatePanel({ bot, mode }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [interval, setRepeatInterval] = useState("");
  const [loading, setLoading] = useState(true);
  const memory = mode === "memory";
  const refresh = useCallback(async () => {
    if (!bot?.id) return;
    try {
      const data = await agentState(
        memory
          ? `memory/${encodeURIComponent(bot.id)}`
          : `routines?bot_id=${encodeURIComponent(bot.id)}`,
      );
      setItems(data);
      setLoading(false);
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  }, [bot?.id, memory]);
  useEffect(() => {
    setItems([]);
    setError("");
    setLoading(true);
    setText("");
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (memory)
        await agentState(`memory/${encodeURIComponent(bot.id)}`, "POST", {
          text,
        });
      else
        await agentState("routines", "POST", {
          bot_id: bot.id,
          name,
          prompt: text,
          run_at: date
            ? new Date(date).toISOString()
            : new Date().toISOString(),
          interval_seconds: interval ? Number(interval) : null,
        });
      setText("");
      setName("");
      setDate("");
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const change = async (item, action) => {
    setError("");
    setBusy(true);
    try {
      const path = memory
        ? `memory/${encodeURIComponent(bot.id)}/${item.id}`
        : `routines/${item.id}${action === "delete" ? "" : "/" + action}`;
      await agentState(path, action === "delete" ? "DELETE" : "POST");
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="state-panel">
      <div className="state-panel-inner">
        <header className="state-heading">
          <div>
            <span className="eyebrow">
              {memory
                ? "UN POCO DE CONTEXTO, MUCHA DIFERENCIA"
                : "AYUDA QUE ENCUENTRA SU MOMENTO"}
            </span>
            <h1>
              {memory
                ? "Lo que importa, se recuerda."
                : "Dale tiempo a tus ideas."}
            </h1>
            <p>
              {bot?.name || "Tu Dot"} ·{" "}
              {memory
                ? "Preferencias, objetivos y pequeños detalles que tu Dot tendrá en cuenta en futuras conversaciones."
                : "Prepara una tarea para ahora o para más adelante. Su resultado aparecerá en la conversación de tu Dot."}
            </p>
          </div>
          <span className="state-header-icon">
            {memory ? <FiBookOpen size={22} /> : <FiClock size={22} />}
          </span>
        </header>
        {error && (
          <p role="alert" className="message-error mb-5">
            {error}
          </p>
        )}
        <form onSubmit={submit} className="state-form">
          {!memory && (
            <label className="field-label">
              Nombre de la rutina
              <input
                className={input}
                required
                maxLength={100}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mi resumen diario"
              />
            </label>
          )}
          <label className="field-label">
            {memory ? "¿Qué quieres que recuerde?" : "¿Qué quieres que haga?"}
            <textarea
              className={input}
              rows={3}
              required
              maxLength={memory ? 4000 : 12000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                memory
                  ? "Prefiero respuestas breves en español…"
                  : "Prepara una agenda para mis objetivos de esta semana…"
              }
            />
          </label>
          {!memory && (
            <div className="grid gap-5 sm:grid-cols-2">
              <label className="field-label">
                Primera ejecución
                <input
                  aria-label="Primera ejecución"
                  className={input}
                  type="datetime-local"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
                <span className="text-xs text-zinc-400">
                  Hora local. Vacío: ejecutar ahora.
                </span>
              </label>
              <label className="field-label">
                Repetición
                <select
                  className={input}
                  value={interval}
                  onChange={(e) => setRepeatInterval(e.target.value)}
                >
                  <option value="">Una vez</option>
                  <option value="3600">Cada hora</option>
                  <option value="86400">Cada 24 horas</option>
                  <option value="604800">Cada 7 días</option>
                </select>
                <span className="text-xs text-zinc-400">
                  Desde el final de la última ejecución.
                </span>
              </label>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <span className="text-xs text-zinc-400">
              {memory
                ? "Puedes editar tu contexto borrando o añadiendo recuerdos."
                : "Las rutinas necesitan que el servidor esté encendido."}
            </span>
            <button className={button} disabled={busy || !bot || loading}>
              <FiPlus />
              {busy
                ? "Guardando…"
                : memory
                  ? "Guardar recuerdo"
                  : "Crear rutina"}
            </button>
          </div>
        </form>
        <div className="state-list-heading">
          <h2>{memory ? "Recuerdos de tu Dot" : "Tus rutinas"}</h2>
          <span>
            {items.length} {memory ? "recuerdos" : "rutinas"}
          </span>
        </div>
        {loading ? (
          <p role="status" className="muted">
            Cargando…
          </p>
        ) : !items.length ? (
          <div className="state-empty">
            {memory ? <FiBookOpen /> : <FiClock />}
            <p>
              {memory
                ? "Un detalle pequeño puede hacer la conversación mucho más tuya."
                : "Tu primera rutina empieza con una tarea."}
            </p>
          </div>
        ) : (
          items.map((item) => (
            <article key={item.id} className="state-item">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  {memory ? (
                    <p className="whitespace-pre-wrap break-words">
                      {item.text}
                    </p>
                  ) : (
                    <>
                      <h2 className="text-sm font-medium">{item.name}</h2>
                      <p className="mt-2 whitespace-pre-wrap break-words">
                        {item.prompt}
                      </p>
                      <div className="mt-4 flex flex-wrap gap-3 text-xs">
                        <span
                          className={
                            item.status === "failed"
                              ? "text-red-300"
                              : item.status === "running"
                                ? "text-violet-300"
                                : "text-emerald-300"
                          }
                        >
                          {labels[item.status]}
                        </span>
                        <span className="text-zinc-400">
                          {new Date(item.run_at).toLocaleString("es-ES")}
                        </span>
                      </div>
                    </>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {!memory && (
                    <>
                      <button
                        title="Ejecutar ahora"
                        aria-label="Ejecutar ahora"
                        disabled={busy || item.status === "running"}
                        onClick={() => change(item, "run")}
                        className="icon-button"
                      >
                        <FiPlay />
                      </button>
                      {["queued", "paused"].includes(item.status) && (
                        <button
                          title={
                            item.status === "paused" ? "Reanudar" : "Pausar"
                          }
                          aria-label={
                            item.status === "paused" ? "Reanudar" : "Pausar"
                          }
                          disabled={busy}
                          onClick={() =>
                            change(
                              item,
                              item.status === "paused" ? "resume" : "pause",
                            )
                          }
                          className="icon-button"
                        >
                          {item.status === "paused" ? <FiPlay /> : <FiPause />}
                        </button>
                      )}
                    </>
                  )}
                  <button
                    title={memory ? "Borrar recuerdo" : "Eliminar rutina"}
                    aria-label={memory ? "Borrar recuerdo" : "Eliminar rutina"}
                    disabled={busy || item.status === "running"}
                    onClick={() => change(item, "delete")}
                    className="icon-button"
                  >
                    <FiTrash2 />
                  </button>
                </div>
              </div>
              {!memory && item.last_result && (
                <details className="mt-4 text-sm text-zinc-400">
                  <summary className="cursor-pointer text-violet-300">
                    Último resultado
                  </summary>
                  <p className="mt-3 whitespace-pre-wrap">{item.last_result}</p>
                </details>
              )}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
