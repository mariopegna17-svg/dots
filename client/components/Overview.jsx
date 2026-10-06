"use client";
import {
  FiArrowUpRight,
  FiPlus,
  FiMessageSquare,
  FiFeather,
  FiCompass,
  FiCheckSquare,
  FiArrowRight,
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
const ideas = [
  {
    icon: FiFeather,
    title: "Encuentra las palabras",
    text: "Dale forma a esa idea que tienes.",
    prompt:
      "Ayúdame a convertir una idea en un texto claro. Hazme unas preguntas para empezar.",
  },
  {
    icon: FiCompass,
    title: "Sigue tu curiosidad",
    text: "Aprende algo, a tu ritmo.",
    prompt:
      "Quiero aprender algo nuevo. Ayúdame a elegir un tema y un plan sencillo.",
  },
  {
    icon: FiCheckSquare,
    title: "Haz espacio para lo importante",
    text: "Organiza tu próximo paso.",
    prompt:
      "Ayúdame a organizar mis prioridades de esta semana. Pregúntame qué quiero conseguir.",
  },
];
export default function Overview({
  bots,
  userName,
  onChat,
  onCreate,
  onTab,
  loading,
}) {
  const first = bots[0];
  return (
    <div className="overview-scroll">
      <div className="overview-inner">
        <section className="welcome-section">
          <div className="welcome-copy">
            <span className="eyebrow">
              <span className="tiny-spark">✳</span> TU ESPACIO, TUS
              POSIBILIDADES
            </span>
            <h1>
              Grandes ideas.
              <br />
              <span>Un poco de ayuda.</span>
            </h1>
            <p>
              {userName && userName !== "Tú" ? `${userName}, este` : "Este"} es
              tu rincón para pensar, crear y avanzar.
              <br className="desktop-break" /> Tus Dots están aquí para
              acompañarte.
            </p>
            <div className="welcome-actions">
              <button
                onClick={() => (first ? onChat(first.id) : onCreate())}
                className="primary-button"
              >
                {first ? `Hablar con ${first.name}` : "Crear mi primer Dot"}
                <FiArrowUpRight />
              </button>
              <button onClick={onCreate} className="text-button">
                <FiPlus />
                Crear un Dot
              </button>
            </div>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <span className="art-spark spark-one">✦</span>
            <span className="art-spark spark-two">✳</span>
            <div className="hero-character hero-character-back">
              <MascotAvatar type="lavender" size="hero" />
            </div>
            <div className="hero-character hero-character-main">
              <MascotAvatar type="lime" size="hero" />
            </div>
            <div className="hero-character hero-character-front">
              <MascotAvatar type="orange" size="hero" />
            </div>
            <span className="art-caption">MEJOR, EN COMPAÑÍA.</span>
          </div>
        </section>
        <section className="agents-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">TU EQUIPO PERSONAL</span>
              <h2>
                Conoce a tus Dots
                <span className="count-tag">{bots.length}</span>
              </h2>
            </div>
            <button className="text-button" onClick={onCreate}>
              <FiPlus />
              Nuevo Dot
            </button>
          </div>
          {loading ? (
            <div className="agent-grid">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="agent-card skeleton-card"
                  aria-label="Cargando agente"
                />
              ))}
            </div>
          ) : (
            <div className="agent-grid">
              {bots.map((bot) => (
                <button
                  key={bot.id}
                  onClick={() => onChat(bot.id)}
                  className={`agent-card tone-${botTone(bot)}`}
                >
                  <span className="agent-card-top">
                    <span className="agent-kind">PERSONAL DOT</span>
                    <FiArrowUpRight />
                  </span>
                  <div className="agent-card-art">
                    <span className="agent-halo" />
                    <MascotAvatar type={botTone(bot)} size="xl" />
                  </div>
                  <div className="agent-card-copy">
                    <h3>{bot.name}</h3>
                    <p>{agentLabel(bot)}</p>
                  </div>
                  <span className="agent-card-bottom">
                    <FiMessageSquare />
                    Abrir conversación
                    <FiArrowRight />
                  </span>
                </button>
              ))}
              <button onClick={onCreate} className="new-agent-card">
                <span className="new-agent-icon">
                  <FiPlus />
                </span>
                <h3>Uno a tu medida</h3>
                <p>
                  Crea un Dot para lo que
                  <br />
                  tienes en mente.
                </p>
                <span>
                  Crear nuevo Dot <FiArrowUpRight />
                </span>
              </button>
            </div>
          )}
        </section>
        <section className="ideas-section">
          <div className="section-heading">
            <div>
              <span className="eyebrow">POR SI NECESITAS UN EMPUJÓN</span>
              <h2>¿Por dónde empezamos?</h2>
            </div>
          </div>
          <div className="idea-grid">
            {ideas.map(({ icon: Icon, title, text, prompt }) => (
              <button
                key={title}
                onClick={() => (first ? onChat(first.id, prompt) : onCreate())}
                className="idea-card"
              >
                <Icon />
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
                <FiArrowUpRight />
              </button>
            ))}
          </div>
        </section>
        <footer className="overview-footer">
          <span>Pequeños pasos. Grandes posibilidades.</span>
          <button className="text-button" onClick={() => onTab("routines")}>
            Explorar rutinas
            <FiArrowRight />
          </button>
        </footer>
      </div>
    </div>
  );
}
