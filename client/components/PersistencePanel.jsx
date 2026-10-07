"use client";
import { useEffect, useState } from "react";
import { FiCheck, FiCloud, FiDownload } from "react-icons/fi";
import { downloadPersistence, fetchPersistence, syncPersistence } from "../lib/api";

export default function PersistencePanel() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let disposed = false;
    async function refresh() {
      try { const data = await fetchPersistence(); if (!disposed) setState(data); }
      catch (failure) { if (!disposed) setError(failure.message); }
    }
    refresh(); const interval = setInterval(refresh, 10000);
    return () => { disposed = true; clearInterval(interval); };
  }, []);
  async function sync() {
    setBusy("sync"); setError(""); setNotice("");
    try { setState(await syncPersistence()); setNotice("Tu copia cifrada está guardada en GitHub."); }
    catch (failure) { setError(failure.message); } finally { setBusy(""); }
  }
  async function download() {
    setBusy("download"); setError("");
    try { const blob = await downloadPersistence(); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = 'dots-state.enc'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    catch (failure) { setError(failure.message); } finally { setBusy(""); }
  }
  return <section className="settings-card persistence-panel"><h3><FiCloud /> Conservar mis datos</h3>
    <p>Claves, memoria, conversaciones, rutinas, equipos, temas y sesión de WhatsApp se guardan juntos en una copia cifrada.</p>
    {state?.configured ? <>
      <p className="persistence-location"><FiCheck /> GitHub · {state.repository} · {state.branch}</p>
      <p>{state.last_success ? `Última copia: ${new Date(state.last_success).toLocaleString('es-ES')}` : "La primera copia todavía no se ha confirmado."}{state.pending && " Hay cambios pendientes."}{state.syncing && " Guardando…"}</p>
      {state.restored && <small>Tus datos se han recuperado de GitHub al arrancar.</small>}
      <button type="button" className="primary-button" disabled={Boolean(busy) || state.syncing} onClick={sync}>{busy === "sync" ? "Guardando…" : "Guardar ahora en GitHub"}</button>
    </> : <>
      <p className="persistence-local">Ahora se usa el disco local. Render Free puede borrarlo; activa la copia para conservar tus datos.</p>
      <ol><li>En GitHub crea un token limitado a este repositorio, con <strong>Contents: Read and write</strong>.</li><li>En Render → Environment añade <code>GITHUB_BACKUP_TOKEN</code> y <code>GITHUB_BACKUP_REPOSITORY</code> con <strong>mariopegna17-svg/dots</strong>.</li><li>Conserva el mismo <code>APP_AUTH_TOKEN</code>. Permite descifrar la copia al arrancar.</li></ol>
      <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer" className="text-button">Crear token de GitHub</a>
    </>}
    <small>Se comprueban los cambios cada 30 segundos y se hace una copia al cerrar normalmente el servidor. «Guardar ahora» confirma la copia sin esperar. Un cierre forzado puede perder los cambios posteriores a la última copia. WhatsApp puede pedir renovar la vinculación si la revoca.</small>
    <button type="button" className="text-button" disabled={Boolean(busy)} onClick={download}><FiDownload />{busy === "download" ? "Preparando…" : "Descargar copia cifrada"}</button>
    {(error || state?.error || notice) && <p role={error || state?.error ? "alert" : "status"} className={error || state?.error ? "message-error" : "muted"}>{error || state?.error || notice}</p>}
  </section>;
}
