"use client";

import React, { useEffect, useState } from "react";
import { FiAlertCircle, FiClock, FiRefreshCw, FiShield } from "react-icons/fi";
import { fetchAuditEvents } from "../lib/api";

function formatTimestamp(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export default function AuditPanel() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadEvents = async () => {
    setLoading(true);
    setError("");
    try {
      setEvents(await fetchAuditEvents(200));
    } catch (err) {
      setError(err.message || "No se pudo cargar la actividad");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEvents();
  }, []);

  const recentEvents = [...events].reverse();

  const names = {
    "routine.created": "Rutina creada",
    "routine.started": "Rutina en marcha",
    "routine.completed": "Rutina completada",
    "routine.failed": "Rutina con error",
    "routine.delete": "Rutina eliminada",
    "routine.pause": "Rutina pausada",
    "routine.resume": "Rutina reanudada",
    "routine.run": "Rutina solicitada",
  };
  return (
    <section className="state-panel">
      <div className="state-panel-inner">
        <header className="state-heading">
          <div>
            <span className="eyebrow">CADA PASO, A LA VISTA</span>
            <h1>Esto es lo que está pasando.</h1>
            <p>
              Las tareas, acciones y permisos de tus Dots, en un mismo lugar.
            </p>
          </div>
          <button
            onClick={loadEvents}
            className="icon-button"
            aria-label="Actualizar actividad"
            title="Actualizar"
          >
            <FiRefreshCw className={loading ? "animate-spin" : ""} />
          </button>
        </header>
        {error && (
          <p className="message-error" role="alert">
            <FiAlertCircle />
            {error}
          </p>
        )}
        {loading && !events.length ? (
          <p role="status" className="muted">
            Cargando actividad…
          </p>
        ) : !recentEvents.length ? (
          <div className="state-empty">
            <FiClock />
            <p>
              Todo empieza con una conversación. Las acciones de tus Dots
              aparecerán aquí.
            </p>
          </div>
        ) : (
          <div className="activity-list">
            {recentEvents.map((item, index) => {
              const event = item.event || item.type || "event";
              return (
                <article
                  key={`${item.created_at}-${index}`}
                  className="activity-item"
                >
                  <span
                    className={`activity-symbol ${event.includes("failed") ? "has-error" : ""}`}
                  >
                    <FiShield />
                  </span>
                  <div className="activity-copy">
                    <h2>{names[event] || event.replace(/[._]/g, " ")}</h2>
                    {item.tool && <p>{item.tool}</p>}
                    <details>
                      <summary>Ver detalles</summary>
                      <div className="activity-meta">
                        {item.request_id && <p>Solicitud: {item.request_id}</p>}
                        {item.thread_id && (
                          <p>Conversación: {item.thread_id}</p>
                        )}
                        {item.connector && <p>Conector: {item.connector}</p>}
                        {item.task_id && <p>Tarea: {item.task_id}</p>}
                        {item.error && (
                          <p className="inline-error">{item.error}</p>
                        )}
                      </div>
                    </details>
                  </div>
                  <time>{formatTimestamp(item.created_at)}</time>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
