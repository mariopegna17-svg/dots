"use client";
import { useState, useEffect, useRef } from "react";
import {
  FiGrid,
  FiSearch,
  FiPlus,
  FiSettings,
  FiActivity,
  FiLogOut,
  FiClock,
  FiBookOpen,
  FiLayers,
  FiX,
  FiChevronDown,
  FiArrowUpRight,
  FiPhone,
} from "react-icons/fi";
import DotBrand from "./DotBrand";
import MascotAvatar, { botTone } from "./MascotAvatar";
import { agentLabel } from "./Overview";

export default function Sidebar({
  onLogout,
  bots,
  activeBotId,
  userName,
  onSelectBot,
  activeTab,
  onSelectTab,
  onOpenSettings,
  onOpenNewBot,
  isOpen,
  onClose,
  providerConfigured,
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const sidebarRef = useRef(null);
  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement;
    const controls = () =>
      [...sidebarRef.current.querySelectorAll("button, input")].filter(
        (element) => element.getClientRects().length,
      );
    controls()[0]?.focus();
    const close = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const elements = controls();
        if (event.shiftKey && document.activeElement === elements[0]) {
          event.preventDefault();
          elements[elements.length - 1]?.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === elements[elements.length - 1]
        ) {
          event.preventDefault();
          elements[0]?.focus();
        }
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      previous?.focus();
    };
  }, [isOpen, onClose]);
  const filtered = bots.filter((bot) =>
    `${bot.name} ${bot.role}`.toLowerCase().includes(searchTerm.toLowerCase()),
  );
  const displayName = userName || "Tú";
  return (
    <>
      {isOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Cerrar navegación"
          onClick={onClose}
        />
      )}
      <aside
        ref={sidebarRef}
        role={isOpen ? "dialog" : undefined}
        aria-modal={isOpen ? true : undefined}
        className={`studio-sidebar ${isOpen ? "is-open" : ""}`}
        aria-label="Navegación principal"
      >
        <div className="sidebar-brand">
          <DotBrand />
          <span className="edition-tag">PERSONAL</span>
          <button
            className="icon-button mobile-only"
            onClick={onClose}
            aria-label="Cerrar menú"
          >
            <FiX />
          </button>
        </div>
        <button className="workspace-switch" onClick={onOpenSettings}>
          <span className="workspace-letter">
            {displayName[0].toUpperCase()}
          </span>
          <span>
            <strong>Mi espacio</strong>
            <small>Solo para ti</small>
          </span>
          <FiChevronDown />
        </button>
        <nav className="main-nav" aria-label="Tu espacio">
          {[
            [FiGrid, "overview", "Inicio"],
            [FiBookOpen, "memory", "Memoria"],
            [FiClock, "routines", "Rutinas"],
            [FiPhone, "contact", "Llamadas y WhatsApp"],
          ].map(([Icon, id, label]) => (
            <button
              key={id}
              className={`nav-item ${activeTab === id ? "active" : ""}`}
              aria-current={activeTab === id ? "page" : undefined}
              onClick={() => onSelectTab(id)}
            >
              <Icon />
              <span>{label}</span>
              {activeTab === id && <span className="nav-active-dot" />}
            </button>
          ))}
        </nav>
        <div className="roster-heading">
          <span className="eyebrow">MIS DOTS</span>
          <button
            className="icon-button"
            onClick={onOpenNewBot}
            aria-label="Crear nuevo Dot"
          >
            <FiPlus />
          </button>
        </div>
        <div className="sidebar-search">
          <FiSearch />
          <input
            aria-label="Buscar agentes"
            placeholder="Buscar un Dot…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <span>/</span>
        </div>
        <div className="dot-roster">
          {filtered.map((bot) => (
            <button
              key={bot.id}
              onClick={() => onSelectBot(bot.id)}
              className={`roster-item ${activeBotId === bot.id && ["chat", "computer"].includes(activeTab) ? "active" : ""}`}
              aria-current={
                activeBotId === bot.id && activeTab === "chat"
                  ? "page"
                  : undefined
              }
            >
              <MascotAvatar type={botTone(bot)} size="md" />
              <span>
                <strong>{bot.name}</strong>
                <small>{agentLabel(bot)}</small>
              </span>
              {activeBotId === bot.id && activeTab === "chat" && (
                <span className="roster-active-mark" />
              )}
            </button>
          ))}
          {!filtered.length && (
            <p className="roster-empty">
              {searchTerm
                ? "No se encontró ese Dot."
                : "Tu primer Dot empieza aquí."}
            </p>
          )}
          <button className="roster-add" onClick={onOpenNewBot}>
            <FiPlus />
            Añadir un Dot
          </button>
        </div>
        <div className="sidebar-bottom">
          <nav aria-label="Herramientas">
            {[
              [FiLayers, "marketplace", "Conectores"],
              [FiActivity, "audit", "Actividad"],
            ].map(([Icon, id, label]) => (
              <button
                key={id}
                className={`nav-item ${activeTab === id ? "active" : ""}`}
                onClick={() => onSelectTab(id)}
              >
                <Icon />
                {label}
              </button>
            ))}
          </nav>
          <button className="provider-indicator" onClick={onOpenSettings}>
            <span
              className={`status-dot ${providerConfigured ? "configured" : ""}`}
            />
            <span>
              {providerConfigured
                ? "Proveedor de IA configurado"
                : "Configura tu proveedor de IA"}
            </span>
            <FiArrowUpRight />
          </button>
          <div className="sidebar-profile">
            <button onClick={onOpenSettings} className="profile-button">
              <span className="profile-avatar">
                {displayName[0].toUpperCase()}
              </span>
              <span>
                <strong>{displayName}</strong>
                <small>Espacio personal</small>
              </span>
            </button>
            <button
              className="icon-button"
              onClick={onOpenSettings}
              aria-label="Abrir ajustes"
            >
              <FiSettings />
            </button>
            <button
              className="icon-button"
              onClick={onLogout}
              aria-label="Cerrar sesión"
            >
              <FiLogOut />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
