"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiCheck, FiExternalLink, FiLink, FiRefreshCw, FiSearch, FiSettings, FiUpload, FiX } from "react-icons/fi";
import { FaGithub, FaWhatsapp, FaYoutube } from "react-icons/fa";
import { SiGmail, SiGooglecalendar, SiGoogledrive, SiNotion, SiSlack } from "react-icons/si";
import { authorizeConnector, configureConnectors, disconnectConnector, discardYouTubeVideo, fetchConnectionStatus, fetchConnectorCatalog, fetchYouTubeChannel, fetchYouTubeUploads } from "../lib/api";
import Modal from "./Modal";
import YouTubePublisher, { YouTubeUploadStatus } from "./YouTubePublisher";

const ICONS = { youtube: FaYoutube, github: FaGithub, gmail: SiGmail, googlecalendar: SiGooglecalendar, googledrive: SiGoogledrive, notion: SiNotion, slack: SiSlack };
function AppIcon({ app }) { const Icon = ICONS[app.slug] || FiLink; return <span className={`connector-app-icon connector-icon-${app.slug}`}><Icon /></span>; }

export default function Marketplace({ onOpenSettings, onOpenContact }) {
  const [apps, setApps] = useState([]);
  const [connected, setConnected] = useState({});
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const [key, setKey] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [pending, setPending] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [channel, setChannel] = useState(null);
  const [channelError, setChannelError] = useState("");
  const [uploads, setUploads] = useState([]);
  const [publisher, setPublisher] = useState(null);
  const keyRef = useRef(null);
  const setupRef = useRef(null);
  const [revision, setRevision] = useState(0);
  const refreshUploads = useCallback(async () => {
    try { setUploads((await fetchYouTubeUploads()).uploads || []); }
    catch (failure) { setError(failure.message); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchConnectorCatalog().then((catalog) => {
      if (cancelled) return;
      setApps(catalog.cards || []); setConfigured(Boolean(catalog.configured));
      if (catalog.warning) setError(catalog.warning);
    }).catch((failure) => { if (!cancelled) setError(failure.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision]);
  const matching = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? apps.filter((a) => `${a.label} ${a.blurb}`.toLowerCase().includes(q)) : expanded ? apps : apps.slice(0, 6);
  }, [apps, search, expanded]);
  const visible = useMemo(() => matching.slice(page * 24, (page + 1) * 24), [matching, page]);
  const statusSlugs = useMemo(() => [...new Set(["youtube", ...visible.map((a) => a.slug)])].join(","), [visible]);
  useEffect(() => {
    let cancelled = false;
    if (!configured) { setConnected({}); return; }
    fetchConnectionStatus(statusSlugs.split(",")).then((result) => { if (!cancelled) setConnected((current) => ({ ...current, ...result.services })); })
      .catch((failure) => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [configured, statusSlugs, revision]);
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer;
    let checking = false;
    async function check() {
      if (checking || cancelled) return;
      checking = true;
      try {
        const status = await fetchConnectionStatus([pending.slug]);
        if (cancelled) return;
        if (status.services?.[pending.slug]?.connected) {
          setConnected((current) => ({ ...current, ...status.services })); setPending(null);
          setNotice(`${pending.label} conectada. Ya puedes usarla.`); return;
        }
      } catch (failure) { if (!cancelled) setError(failure.message); }
      finally { checking = false; }
      if (!cancelled) {
        if (Date.now() > pending.until) { setPending(null); setNotice("La autorización sigue pendiente. Pulsa Conectar para volver a intentarlo."); }
        else { clearTimeout(timer); timer = setTimeout(check, 3000); }
      }
    }
    check(); window.addEventListener("focus", check);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener("focus", check); };
  }, [pending]);
  const youtubeConnected = Boolean(connected.youtube?.connected);
  useEffect(() => {
    let cancelled = false;
    setChannel(null); setChannelError("");
    if (youtubeConnected) fetchYouTubeChannel().then((data) => { if (!cancelled) setChannel(data); }).catch((failure) => { if (!cancelled) setChannelError(failure.message); });
    return () => { cancelled = true; };
  }, [youtubeConnected, revision]);
  useEffect(() => { refreshUploads(); }, [refreshUploads]);
  const uploading = uploads.some((i) => i.status === "uploading");
  useEffect(() => {
    if (!uploading) return;
    const interval = setInterval(refreshUploads, 2500);
    return () => clearInterval(interval);
  }, [uploading, refreshUploads]);
  function openSetup() { setSetupOpen(true); setTimeout(() => { setupRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }); keyRef.current?.focus(); }, 0); }
  async function saveKey(event) {
    event.preventDefault(); setBusy("setup"); setError("");
    try {
      if (key.trim().startsWith("nvapi-")) throw new Error("Esta es una clave de NVIDIA. Aquí necesitas la clave de Composio del enlace de arriba.");
      await configureConnectors(key.trim()); setKey(""); setConnected({}); setConfigured(true); setSetupOpen(false); setRevision((n) => n + 1); setNotice("Configuración guardada. Ahora elige la aplicación que quieres conectar.");
    } catch (failure) { setError(failure.message); } finally { setBusy(""); }
  }
  async function connect(app) {
    if (!configured) { openSetup(); return; }
    setBusy(app.slug); setError(""); setNotice("");
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const { url } = await authorizeConnector(app.slug);
      if (popup && !popup.closed) popup.location.replace(url);
      setPending({ ...app, url, until: Date.now() + 180000 });
      setNotice(`Autoriza ${app.label} en la pestaña de conexión. Detectaremos la cuenta automáticamente.`);
    } catch (failure) { if (popup && !popup.closed) popup.close(); setError(failure.message); }
    finally { setBusy(""); }
  }
  async function removeConnection() {
    setBusy(disconnecting.slug); setError("");
    try { await disconnectConnector(disconnecting.slug); setConnected((current) => ({ ...current, [disconnecting.slug]: { connected: false } })); setNotice(`${disconnecting.label} desconectada.`); setDisconnecting(null); }
    catch (failure) { setError(failure.message); } finally { setBusy(""); }
  }
  async function removeUpload(id) {
    try { await discardYouTubeVideo(id); await refreshUploads(); } catch (failure) { setError(failure.message); }
  }
  return <section className="state-panel"><div className="connectors-inner">
    <header className="state-heading"><div><span className="eyebrow">TUS CUENTAS, A UN CLIC</span><h1>Conectores</h1><p>Conecta una cuenta, autorízala y empieza. Todo desde aquí.</p></div><button className="icon-button" aria-label="Actualizar conectores" onClick={() => { setError(""); setRevision((n) => n + 1); refreshUploads(); }} disabled={Boolean(busy)}><FiRefreshCw className={loading ? "animate-spin" : ""} /></button></header>
    {(error || notice) && <p className={error ? "connector-feedback message-error" : "connector-feedback"} role={error ? "alert" : "status"}>{error || notice}</p>}
    {pending && <div className="connector-notice"><FiExternalLink /><p>Esperando autorización de {pending.label}… <a href={pending.url} target="_blank" rel="noopener noreferrer">Abrir conexión</a></p><button className="text-button" onClick={() => setPending(null)}>Dejar de esperar</button></div>}
    <section className="connector-setup" ref={setupRef} aria-label="Configuración de conectores">
      {configured && !setupOpen ? <div className="connector-setup-ready"><span><FiCheck /> Conexiones listas</span><button className="text-button" onClick={openSetup}><FiSettings /> Cambiar clave</button></div> : <>
        <h2>Configura una vez. Conecta las que quieras.</h2><p>Las cuentas de aplicaciones se conectan con Composio. Solo necesitas una clave para todas; la de NVIDIA sigue siendo para tus Dots.</p>
        <ol className="connector-setup-steps"><li><a href="https://dashboard.composio.dev/settings" target="_blank" rel="noopener noreferrer">Abre Composio <FiExternalLink /></a> y crea o copia la API key de tu proyecto.</li><li>Pégala aquí y pulsa Guardar. Después, elige la aplicación y autoriza tu cuenta.</li></ol>
        <form onSubmit={saveKey}><label htmlFor="connector-api-key">Clave de Composio</label><div><input id="connector-api-key" ref={keyRef} type="password" value={key} autoComplete="off" placeholder="Pega tu API key de Composio" required minLength={10} maxLength={500} disabled={Boolean(busy)} onChange={(e) => setKey(e.target.value)} /><button className="primary-button" disabled={Boolean(busy) || !key.trim()}>{busy === "setup" ? "Comprobando…" : "Guardar clave"}</button></div></form><small>La clave se comprueba y se guarda cifrada. Composio y YouTube tienen sus propias cuotas.</small>
        {configured && <button className="text-button" onClick={() => { setKey(""); setSetupOpen(false); }}>Cancelar</button>}
      </>}
    </section>
    <article className="youtube-connector-feature">
      <div className="youtube-feature-heading"><AppIcon app={{ slug: "youtube" }} /><div><span className="eyebrow">PUBLICA DESDE TU ESPACIO</span><h2>YouTube</h2><p>{channel ? `Conectado a ${channel.channel_name}` : "Tu vídeo, tu canal y tú decides quién lo ve."}</p></div><span className="connector-state">{youtubeConnected ? "Conectado" : "Sin conectar"}</span></div>
      <p>Selecciona el vídeo, añade título y descripción y revisa la privacidad antes de subirlo. También puedes dejar un borrador para tu Dot.</p>
      {channelError && <p className="message-error" role="alert">{channelError}</p>}
      <div className="youtube-feature-buttons">{youtubeConnected ? <><button className="primary-button" onClick={() => setPublisher({ draft: null })} disabled={!channel || uploading}><FiUpload />{uploading ? "Subida en marcha…" : "Añadir vídeo"}</button><button className="text-button" onClick={() => setDisconnecting({ slug: "youtube", label: "YouTube" })} disabled={Boolean(busy) || uploading}>Desconectar</button><a href="https://studio.youtube.com" className="text-button" target="_blank" rel="noopener noreferrer">YouTube Studio <FiExternalLink /></a></> : <button className="primary-button" onClick={() => connect({ slug: "youtube", label: "YouTube" })} disabled={Boolean(busy) || Boolean(pending)}><FiLink />{busy === "youtube" ? "Abriendo conexión…" : "Conectar YouTube"}</button>}<small>MP4, MOV y WebM · hasta 50 MB · privado por defecto</small></div>
      {uploads.length > 0 && <div className="youtube-uploads">{uploads.slice(0, 5).map((item) => <YouTubeUploadStatus key={item.id} item={item} onReview={(draft) => setPublisher({ draft })} onRemove={removeUpload} />)}</div>}
    </article>
    <div className="connector-controls"><div className="connector-search"><FiSearch /><input value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} aria-label="Buscar aplicaciones" placeholder="Busca una aplicación…" /></div><button className="text-button" onClick={() => { setExpanded((v) => !v); setPage(0); }}>{expanded ? "Ver recomendadas" : "Ver todas"}</button></div>
    {loading && !apps.length ? <p className="muted" role="status">Cargando conectores…</p> : <div className="connector-grid">{visible.filter((a) => a.slug !== "youtube").map((app) => <article key={app.slug} className="connector-card"><div className="connector-card-top"><AppIcon app={app} />{connected[app.slug]?.connected && <span className="connector-connected"><FiCheck /> Conectada</span>}</div><h2>{app.label}</h2><p>{app.blurb}</p><button className="connector-button" disabled={Boolean(busy) || Boolean(pending)} onClick={() => connected[app.slug]?.connected ? setDisconnecting(app) : connect(app)}>{busy === app.slug ? "Conectando…" : connected[app.slug]?.connected ? "Desconectar" : "Conectar"}<FiLink /></button></article>)}</div>}
    {!loading && !visible.length && <p className="muted">No hay aplicaciones con ese nombre.</p>}
    {matching.length > 24 && <div className="connector-pagination"><button className="compact-button" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>Anterior</button><span>Página {page + 1} de {Math.ceil(matching.length / 24)}</span><button className="compact-button" disabled={(page + 1) * 24 >= matching.length} onClick={() => setPage((n) => n + 1)}>Siguiente</button></div>}
    <div className="connector-footer"><p>YouTube y GitHub tienen acciones integradas. En las demás aplicaciones puedes vincular la cuenta; sus acciones se añadirán más adelante.</p><button className="text-button" onClick={onOpenContact}><FaWhatsapp /> WhatsApp por QR</button><button className="text-button" onClick={onOpenSettings}><FiSettings /> Ajustes</button></div>
    {publisher && <YouTubePublisher draft={publisher.draft} onClose={() => setPublisher(null)} onChanged={refreshUploads} />}
    {disconnecting && <Modal onClose={() => { if (!busy) setDisconnecting(null); }} titleId="connector-disconnect-title" className="connector-disconnect"><header className="modal-heading"><h2 id="connector-disconnect-title">Desconectar {disconnecting.label}</h2><button className="icon-button" disabled={Boolean(busy)} onClick={() => setDisconnecting(null)} aria-label="Cancelar desconexión"><FiX /></button></header><p>Se eliminará la conexión de esta aplicación con tu espacio. Podrás autorizarla de nuevo cuando quieras.</p><footer><button className="compact-button" disabled={Boolean(busy)} onClick={() => setDisconnecting(null)}>Cancelar</button><button className="primary-button" disabled={Boolean(busy)} onClick={removeConnection}>{busy ? "Desconectando…" : "Desconectar cuenta"}</button></footer></Modal>}
  </div></section>;
}
