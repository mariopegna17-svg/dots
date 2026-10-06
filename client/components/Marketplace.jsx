"use client";

import React, { useEffect, useState } from "react";
import {
  FiAlertCircle,
  FiCheck,
  FiExternalLink,
  FiRefreshCw,
  FiSearch,
  FiSettings,
  FiZap,
} from "react-icons/fi";
import {
  authorizeConnector,
  disconnectConnector,
  fetchConnectionStatus,
  fetchConnectorCatalog,
} from "../lib/api";

// A stable fallback keeps the marketplace useful when the API or connector key
// is not configured yet.
const CURATED_APPS = [
  {
    slug: "github",
    label: "GitHub",
    blurb: "Issues, pull requests, and code",
    domain: "github.com",
  },
  {
    slug: "slack",
    label: "Slack",
    blurb: "Post updates and read channels",
    domain: "slack.com",
  },
  {
    slug: "gmail",
    label: "Gmail",
    blurb: "Read and send email",
    domain: "gmail.com",
  },
  {
    slug: "googlecalendar",
    label: "Google Calendar",
    blurb: "Read and create calendar events",
    domain: "calendar.google.com",
  },
  {
    slug: "googlesheets",
    label: "Google Sheets",
    blurb: "Read and update spreadsheets",
    domain: "sheets.google.com",
  },
  {
    slug: "googledocs",
    label: "Google Docs",
    blurb: "Read and write documents",
    domain: "docs.google.com",
  },
  {
    slug: "googledrive",
    label: "Google Drive",
    blurb: "Browse and manage files",
    domain: "drive.google.com",
  },
  {
    slug: "notion",
    label: "Notion",
    blurb: "Pages and databases",
    domain: "notion.so",
  },
  {
    slug: "linear",
    label: "Linear",
    blurb: "Issues and project tracking",
    domain: "linear.app",
  },
  {
    slug: "discord",
    label: "Discord",
    blurb: "Messages and channels",
    domain: "discord.com",
  },
  {
    slug: "x",
    label: "X (Twitter)",
    blurb: "Post and read on X",
    domain: "x.com",
  },
  {
    slug: "hubspot",
    label: "HubSpot",
    blurb: "CRM search and updates",
    domain: "hubspot.com",
  },
  {
    slug: "salesforce",
    label: "Salesforce",
    blurb: "CRM records and reports",
    domain: "salesforce.com",
  },
  {
    slug: "jira",
    label: "Jira",
    blurb: "Issues and sprints",
    domain: "atlassian.com",
  },
  {
    slug: "asana",
    label: "Asana",
    blurb: "Tasks and projects",
    domain: "asana.com",
  },
  {
    slug: "trello",
    label: "Trello",
    blurb: "Boards and cards",
    domain: "trello.com",
  },
  {
    slug: "dropbox",
    label: "Dropbox",
    blurb: "Files and folders",
    domain: "dropbox.com",
  },
  {
    slug: "airtable",
    label: "Airtable",
    blurb: "Bases and records",
    domain: "airtable.com",
  },
  {
    slug: "figma",
    label: "Figma",
    blurb: "Files and comments",
    domain: "figma.com",
  },
  {
    slug: "stripe",
    label: "Stripe",
    blurb: "Payments and customers",
    domain: "stripe.com",
  },
  {
    slug: "zapier",
    label: "Zapier",
    blurb: "Connect apps through automation",
    domain: "zapier.com",
  },
  {
    slug: "reddit",
    label: "Reddit",
    blurb: "Browse and post on Reddit",
    domain: "reddit.com",
  },
  {
    slug: "sentry",
    label: "Sentry",
    blurb: "Errors, alerts, and performance",
    domain: "sentry.io",
  },
  {
    slug: "posthog",
    label: "PostHog",
    blurb: "Analytics and feature flags",
    domain: "posthog.com",
  },
];

const LS_KEY = "open_dots_connected_plugins";

function loadLocalEnabled() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveLocalEnabled(slugs) {
  localStorage.setItem(LS_KEY, JSON.stringify(slugs));
}

function normalizeCard(app) {
  return {
    slug: app.slug || app.key || app.name,
    label: app.label || app.name || app.slug,
    blurb: app.blurb || app.description || "Connector integration",
    domain: app.domain || "",
    logo: app.logo || null,
  };
}

function AppIcon({ app }) {
  const [failed, setFailed] = useState(false);
  const source =
    app.logo ||
    (app.domain
      ? `https://www.google.com/s2/favicons?domain=${app.domain}&sz=64`
      : null);

  if (source && !failed) {
    return (
      <img
        src={source}
        alt=""
        className="w-8 h-8 rounded-lg object-contain flex-shrink-0"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div className="w-8 h-8 rounded-lg bg-[#27272a] flex items-center justify-center text-xs font-bold text-zinc-300 border border-[#333338] flex-shrink-0">
      {(app.label || "?").charAt(0).toUpperCase()}
    </div>
  );
}

export default function Marketplace({ onOpenSettings }) {
  const [apps, setApps] = useState(CURATED_APPS);
  const [connected, setConnected] = useState([]);
  const [search, setSearch] = useState("");
  const [configured, setConfigured] = useState(false);
  const [source, setSource] = useState("curated");
  const [loading, setLoading] = useState(true);
  const [busySlug, setBusySlug] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let mounted = true;

    async function loadMarketplace() {
      setLoading(true);
      setError("");

      const catalog = await fetchConnectorCatalog();
      const nextApps = (catalog.cards || []).length
        ? catalog.cards.map(normalizeCard)
        : CURATED_APPS;

      if (!mounted) return;
      setApps(nextApps);
      setConfigured(Boolean(catalog.configured));
      setSource(catalog.source || "curated");

      if (catalog.configured && nextApps.length) {
        const status = await fetchConnectionStatus(
          nextApps.map((app) => app.slug),
        );
        if (!mounted) return;
        setConnected(
          Object.entries(status.services || {})
            .filter(([, value]) => value && value.connected)
            .map(([slug]) => slug),
        );
        if (status.error) setError(status.error);
      } else {
        setConnected(loadLocalEnabled());
      }

      if (mounted) setLoading(false);
    }

    loadMarketplace().catch((err) => {
      if (!mounted) return;
      setError(err.message || "Could not load connector catalog");
      setLoading(false);
    });

    return () => {
      mounted = false;
    };
  }, [refreshToken]);

  const toggle = async (app) => {
    if (busySlug) return;
    setNotice("");
    setError("");

    const isOn = connected.includes(app.slug);
    if (!configured) {
      const next = isOn
        ? connected.filter((slug) => slug !== app.slug)
        : [...connected, app.slug];
      setConnected(next);
      saveLocalEnabled(next);
      setNotice(
        "Local preference saved. Add a Composio key to authorize a real account.",
      );
      return;
    }

    setBusySlug(app.slug);
    let authWindow = null;
    try {
      if (!isOn && typeof window !== "undefined") {
        authWindow = window.open("", "_blank");
      }

      if (isOn) {
        await disconnectConnector(app.slug);
        setConnected((current) => current.filter((slug) => slug !== app.slug));
        setNotice(`${app.label} desconectada.`);
      } else {
        const result = await authorizeConnector(app.slug);
        if (!result.url)
          throw new Error("The connector did not return an authorization link");
        if (authWindow) {
          authWindow.location.href = result.url;
        } else if (typeof window !== "undefined") {
          window.open(result.url, "_blank", "noopener,noreferrer");
        }
        setNotice(
          `Autorización abierta para ${app.label}. Actualiza después de completarla.`,
        );
      }
    } catch (err) {
      if (authWindow && !authWindow.closed) authWindow.close();
      setError(err.message || `Could not update ${app.label}`);
    } finally {
      setBusySlug(null);
    }
  };

  const visible = apps.filter((app) => {
    if (!search) return true;
    const query = search.toLowerCase();
    return `${app.label} ${app.slug} ${app.blurb}`
      .toLowerCase()
      .includes(query);
  });

  return (
    <section className="state-panel">
      <div className="connectors-inner">
        <header className="state-heading">
          <div>
            <span className="eyebrow">MÁS CERCA DE TUS HERRAMIENTAS</span>
            <h1>Todo un poco más conectado.</h1>
            <p>
              Explora aplicaciones que pueden acompañar a tus Dots. Cada cuenta
              se conecta solo con tu autorización.
            </p>
          </div>
          <button
            className="icon-button"
            onClick={() => setRefreshToken((value) => value + 1)}
            aria-label="Actualizar conectores"
          >
            <FiRefreshCw className={loading ? "animate-spin" : ""} />
          </button>
        </header>
        <div className="connector-controls">
          <div className="connector-search">
            <FiSearch />
            <input
              aria-label="Buscar aplicaciones"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Encuentra tus aplicaciones…"
            />
          </div>
          <span className="count-tag">
            {configured ? connected.length + " conectadas" : "Catálogo"}
          </span>
        </div>
        {!configured && (
          <div className="connector-notice">
            <FiZap />
            <p>
              Para conectar tus cuentas, configura el proveedor de conectores en
              Ajustes.
            </p>
            <button className="text-button" onClick={onOpenSettings}>
              Configurar
              <FiSettings />
            </button>
          </div>
        )}
        {(notice || error) && (
          <p
            role={error ? "alert" : "status"}
            className={error ? "message-error mb-5" : "muted mb-5"}
          >
            {error || notice}
          </p>
        )}
        {loading && !apps.length ? (
          <p className="muted" role="status">
            Cargando conectores…
          </p>
        ) : !visible.length ? (
          <div className="state-empty">
            <FiSearch />
            <p>No hay aplicaciones con ese nombre.</p>
          </div>
        ) : (
          <div className="connector-grid">
            {visible.map((app) => {
              const isOn = configured && connected.includes(app.slug);
              return (
                <article key={app.slug} className="connector-card">
                  <div className="connector-card-top">
                    <AppIcon app={app} />
                    {isOn && (
                      <span className="connector-connected">
                        <FiCheck />
                        Conectada
                      </span>
                    )}
                  </div>
                  <h2>{app.label}</h2>
                  <p>{app.blurb}</p>
                  <button
                    disabled={Boolean(busySlug) || !configured}
                    onClick={() => toggle(app)}
                    className="connector-button"
                  >
                    {busySlug === app.slug
                      ? "Conectando…"
                      : isOn
                        ? "Desconectar"
                        : configured
                          ? "Conectar aplicación"
                          : "Requiere configuración"}
                    {configured && <FiExternalLink />}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
