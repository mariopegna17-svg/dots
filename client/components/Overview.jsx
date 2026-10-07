"use client";
import { useState } from "react";
import {
  FiPlus,
  FiArrowUp,
  FiArrowUpRight,
  FiBookOpen,
  FiClock,
  FiPhone,
} from "react-icons/fi";
import MascotAvatar, { botTone } from "./MascotAvatar";
export function agentLabel(bot) {
  return (
    {
      "bot-open-dots-1": "Tu asistente personal",
      "bot-claude-1": "Código y nuevas soluciones",
      "bot-codex-1": "Orden para tus proyectos",
      "bot-supa-1": "Preguntas y descubrimientos",
    }[bot?.id] ||
    bot?.role ||
    "Asistente personal"
  );
}
export default function Overview({
  bots,
  userName,
  onChat,
  onCreate,
  onTab,
  loading,
}) {
  const [prompt, setPrompt] = useState("");
  const first = bots[0];
  return (
    <div className="overview-scroll">
      <div className="home-inner">
        <section className="home-welcome">
          <MascotAvatar type={first ? botTone(first) : "blue"} size="lg" />
          <h1>
            {userName && userName !== "Tú"
              ? `Hola, ${userName}.`
              : "¿Qué hacemos hoy?"}
          </h1>
          <p>Un Dot para cada idea. Todo en tu espacio.</p>
          <form
            className="home-prompt"
            onSubmit={(event) => {
              event.preventDefault();
              if (prompt.trim() && first) onChat(first.id, prompt.trim());
              else if (!first) onCreate();
            }}
          >
            <input
              aria-label="Empezar una conversación"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Pregunta algo o cuéntame qué necesitas…"
            />
            <button
              className="home-send"
              aria-label="Abrir conversación"
              disabled={loading || (!prompt.trim() && Boolean(first))}
            >
              <FiArrowUp />
            </button>
          </form>
          <div className="home-suggestions">
            {[
              "Organizar mi semana",
              "Investigar una idea",
              "Preparar un proyecto",
            ].map((text) => (
              <button
                key={text}
                disabled={loading}
                onClick={() => (first ? onChat(first.id, text) : onCreate())}
              >
                {text}
              </button>
            ))}
          </div>
        </section>
        <section className="home-dots">
          <div className="home-section-heading">
            <h2>
              Mis dots <span>{bots.length}</span>
            </h2>
            <button className="text-button" onClick={onCreate}>
              <FiPlus /> Crear Dot
            </button>
          </div>
          <div className="home-dot-grid">
            {loading
              ? [1, 2, 3].map((id) => (
                  <div
                    className="home-dot-card skeleton-card"
                    key={id}
                    aria-label="Cargando Dot"
                  />
                ))
              : bots.map((dot) => (
                  <button
                    key={dot.id}
                    className="home-dot-card"
                    data-liquid-tilt=""
                    data-tone={botTone(dot)}
                    onClick={() => onChat(dot.id)}
                  >
                    <MascotAvatar type={botTone(dot)} size="xl" />
                    <strong>{dot.name}</strong>
                    <p>{agentLabel(dot)}</p>
                    <span>
                      Abrir conversación <FiArrowUpRight />
                    </span>
                  </button>
                ))}
            {!loading && (
              <button className="home-dot-card home-new-dot" data-liquid-tilt="" onClick={onCreate}>
                <div>
                  <FiPlus />
                </div>
                <strong>Nuevo Dot</strong>
                <p>Dale un nombre y una tarea.</p>
                <span>
                  Crear <FiArrowUpRight />
                </span>
              </button>
            )}
          </div>
        </section>
        <section className="home-shortcuts">
          <h2>A mano</h2>
          <div>
            {[
              [FiBookOpen, "memory", "Memoria", "Lo que tus Dots recuerdan."],
              [FiClock, "routines", "Rutinas", "Tus tareas programadas."],
              [
                FiPhone,
                "contact",
                "Llamadas y WhatsApp",
                "Tus Dots, en tu teléfono.",
              ],
            ].map(([Icon, id, title, text]) => (
              <button key={id} onClick={() => onTab(id)}>
                <Icon />
                <span>
                  <strong>{title}</strong>
                  <small>{text}</small>
                </span>
                <FiArrowUpRight />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
