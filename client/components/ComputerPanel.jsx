"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  FiAlertCircle,
  FiArrowLeft,
  FiCpu,
  FiHardDrive,
  FiMonitor,
  FiPause,
  FiPlay,
  FiRefreshCw,
  FiSquare,
  FiTerminal,
} from "react-icons/fi";

import {
  fetchComputerScreenshot,
  fetchComputerStatus,
  pauseComputer,
  resetComputer,
  startComputer,
  stopComputer,
} from "../lib/api";

const ACTIVE_STATES = new Set(["running", "paused"]);

function prettyState(state) {
  return (
    {
      stopped: "Apagado",
      starting: "Iniciando",
      running: "En marcha",
      paused: "En pausa",
      resetting: "Reiniciando",
      error: "Error",
    }[state] || state
  );
}

export default function ComputerPanel({ bot, onBackToChat }) {
  const [computer, setComputer] = useState(null);
  const [screen, setScreen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingAction, setLoadingAction] = useState("");
  const [error, setError] = useState("");

  const botId = bot?.id;
  const state = computer?.state || "stopped";

  const refresh = useCallback(
    async (includeScreen = true) => {
      if (!botId) return;
      try {
        const statusPayload = await fetchComputerStatus(botId);
        const nextComputer = statusPayload.status;
        setComputer(nextComputer);
        if (includeScreen && ACTIVE_STATES.has(nextComputer.state)) {
          const screenPayload = await fetchComputerScreenshot(botId);
          setScreen(screenPayload.result || null);
        } else if (!ACTIVE_STATES.has(nextComputer.state)) {
          setScreen(null);
        }
        setError("");
      } catch (err) {
        setError(err.message || "El entorno del ordenador no está disponible.");
      } finally {
        setLoading(false);
      }
    },
    [botId],
  );

  useEffect(() => {
    let disposed = false;
    setComputer(null);
    setScreen(null);
    setError("");
    setLoading(true);

    async function load() {
      if (!botId || disposed) return;
      try {
        const statusPayload = await fetchComputerStatus(botId);
        if (disposed) return;
        setComputer(statusPayload.status);
        if (ACTIVE_STATES.has(statusPayload.status.state)) {
          const screenPayload = await fetchComputerScreenshot(botId);
          if (!disposed) setScreen(screenPayload.result || null);
        }
      } catch (err) {
        if (!disposed)
          setError(
            err.message || "El entorno del ordenador no está disponible.",
          );
      } finally {
        if (!disposed) setLoading(false);
      }
    }

    load();
    const interval = window.setInterval(() => {
      if (!disposed) refresh(true);
    }, 4000);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [botId, refresh]);

  const runAction = async (name, operation) => {
    if (!botId) return;
    setLoadingAction(name);
    setError("");
    try {
      await operation(botId);
      await refresh(true);
    } catch (err) {
      setError(err.message || `Computer ${name} failed.`);
    } finally {
      setLoadingAction("");
    }
  };

  const capabilities = useMemo(() => computer?.capabilities || [], [computer]);

  if (!bot)
    return (
      <div className="state-panel">
        <p className="muted">Selecciona un Dot para abrir su ordenador.</p>
      </div>
    );
  const actionBusy = Boolean(loadingAction);
  const capabilityNames = {
    "browser.navigate": "Navegar por páginas",
    "terminal.exec": "Ejecutar comandos",
    "files.list": "Consultar archivos",
    screenshot: "Capturar la pantalla",
    input: "Usar teclado y ratón",
    cleanup: "Cerrar el entorno",
  };
  return (
    <section className="computer-workspace">
      <header className="computer-heading">
        <div>
          <span className="eyebrow">UN ENTORNO PARA HACER COSAS</span>
          <h1>El ordenador de {bot.name}.</h1>
          <p className="muted">Su espacio de trabajo, bajo tu control.</p>
        </div>
        <button className="text-button" onClick={onBackToChat}>
          <FiArrowLeft />
          Volver al chat
        </button>
      </header>
      {error && (
        <p role="alert" className="message-error">
          <FiAlertCircle />
          {error}
        </p>
      )}
      <div className="computer-toolbar">
        <span
          className={`computer-state ${state === "running" ? "running" : ""}`}
        >
          <span className="status-dot" />
          {prettyState(state)}
        </span>
        <div className="computer-actions">
          {state === "running" ? (
            <button
              onClick={() => runAction("pause", pauseComputer)}
              disabled={actionBusy}
              className="compact-button"
            >
              <FiPause />
              {loadingAction === "pause" ? "Pausando…" : "Pausar"}
            </button>
          ) : (
            <button
              onClick={() => runAction("start", startComputer)}
              disabled={
                actionBusy || state === "starting" || state === "resetting"
              }
              className="primary-button"
            >
              <FiPlay />
              {loadingAction === "start"
                ? "Iniciando…"
                : state === "paused"
                  ? "Reanudar"
                  : "Iniciar ordenador"}
            </button>
          )}
          <button
            onClick={() => runAction("reset", resetComputer)}
            disabled={actionBusy}
            className="icon-button"
            aria-label="Reiniciar ordenador"
            title="Reiniciar"
          >
            <FiRefreshCw />
          </button>
          <button
            onClick={() => runAction("stop", stopComputer)}
            disabled={actionBusy || state === "stopped"}
            className="icon-button"
            aria-label="Apagar ordenador"
            title="Apagar"
          >
            <FiSquare />
          </button>
        </div>
      </div>
      <div className="computer-layout">
        <div className="computer-display">
          <div className="screen-title">
            <FiMonitor />
            <span>Pantalla</span>
            {computer && (
              <span>
                {computer.width} × {computer.height}
              </span>
            )}
          </div>
          <div className="screen-canvas">
            {screen?.available && screen.data ? (
              <img
                src={`data:image/${screen.format || "jpeg"};base64,${screen.data}`}
                alt={`Pantalla del ordenador de ${bot.name}`}
              />
            ) : (
              <div className="screen-empty">
                <span className="screen-empty-icon">
                  <FiMonitor />
                </span>
                <h2>
                  {loading
                    ? "Preparando tu espacio…"
                    : state === "paused"
                      ? "Una pausa para pensar."
                      : "Listo para el próximo paso."}
                </h2>
                <p>
                  {screen?.available
                    ? screen.message ||
                      "El entorno todavía no ha enviado una imagen."
                    : "Inicia un entorno compatible para ver la pantalla y trabajar con tu Dot."}
                </p>
                <span>Las acciones del agente requieren tu permiso.</span>
              </div>
            )}
          </div>
        </div>
        <aside className="computer-details">
          <div className="computer-info-card">
            <h2>
              <FiCpu />
              Su espacio de trabajo
            </h2>
            <dl>
              <div>
                <dt>Estado</dt>
                <dd>{prettyState(state)}</dd>
              </div>
              <div>
                <dt>Conexión</dt>
                <dd>
                  {computer?.health === "healthy"
                    ? "Preparada"
                    : computer?.health === "unhealthy"
                      ? "No disponible"
                      : "Sin comprobar"}
                </dd>
              </div>
            </dl>
            <details>
              <summary>Detalles del entorno</summary>
              <p>
                {computer?.provider || "Sin configurar"}
                <br />
                {computer?.computer_id}
              </p>
            </details>
          </div>
          <div className="computer-info-card">
            <h2>
              <FiTerminal />
              Herramientas del entorno
            </h2>
            {loading ? (
              <p className="muted">Cargando…</p>
            ) : (
              <ul>
                {capabilities.map((capability) => (
                  <li key={capability}>
                    <span className="capability-dot" />
                    {capabilityNames[capability] || capability}
                  </li>
                ))}
              </ul>
            )}
            <p className="computer-note">
              <FiHardDrive />
              Las herramientas necesitan un entorno conectado.
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
