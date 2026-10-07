"use client";
import { useEffect, useState } from "react";
import { FiSearch, FiX } from "react-icons/fi";
import Modal from "./Modal";
import { fetchConnectorActions } from "../lib/api";

export default function ConnectorActions({ app, onClose, onChat }) {
  const [query, setQuery] = useState("");
  const [actions, setActions] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    fetchConnectorActions(app.slug).then((data) => {
      if (!cancelled) { setActions(data.actions || []); setCursor(data.next_cursor); }
    }).catch((failure) => { if (!cancelled) setError(failure.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [app.slug]);
  async function search(event, next = "") {
    event?.preventDefault(); setLoading(true); setError("");
    try { const data = await fetchConnectorActions(app.slug, query, next); setActions(data.actions || []); setCursor(data.next_cursor); }
    catch (failure) { setError(failure.message); } finally { setLoading(false); }
  }
  return <Modal onClose={onClose} titleId="connector-actions-title" className="connector-actions-modal">
    <header className="modal-heading"><div><span className="eyebrow">HERRAMIENTAS DE TU CUENTA</span><h2 id="connector-actions-title">Acciones de {app.label}</h2></div><button className="icon-button" aria-label="Cerrar acciones" onClick={onClose}><FiX /></button></header>
    <p>Tu Dot puede buscar y utilizar las acciones de esta cuenta. Las consultas recuperan información; los envíos y cambios se revisan antes de ejecutarse.</p>
    {app.slug === "gmail" && <p className="connector-example">Prueba en el chat: «Resume mis últimos 5 correos de Gmail».</p>}
    <form className="connector-actions-search" onSubmit={search}><label className="sr-only" htmlFor="connector-action-query">Buscar acciones</label><input id="connector-action-query" placeholder="Busca una acción, por ejemplo: fetch emails" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={250} /><button className="compact-button" disabled={loading}><FiSearch /> Buscar</button></form>
    {error && <p className="message-error" role="alert">{error}</p>}
    {loading ? <p className="muted" role="status">Consultando acciones disponibles…</p> : <div className="connector-action-list">{actions.map((action) => <article key={action.action}><header><strong>{action.name}</strong><span>{action.requires_approval ? "Con revisión" : "Consulta"}</span></header><p>{action.description}</p></article>)}{!error && !actions.length && <p className="muted">No se encontraron acciones. Prueba con otras palabras o revisa los permisos de tu conexión.</p>}</div>}
    <footer>{cursor && <button className="compact-button" disabled={loading} onClick={(event) => search(event, cursor)}>Ver más acciones</button>}<button className="primary-button" onClick={onChat}>Abrir chat con mi Dot</button></footer>
  </Modal>;
}
