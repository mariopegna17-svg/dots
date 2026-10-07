"use client";
import { useState } from "react";
import { FiArrowLeft, FiCheck, FiExternalLink, FiFile, FiUpload, FiX } from "react-icons/fi";
import Modal from "./Modal";
import { discardYouTubeVideo, prepareYouTubeVideo, publishYouTubeVideo } from "../lib/api";

export const PRIVACY = { private: "Privado", unlisted: "Oculto · solo con enlace", public: "Público" };
export const uploadSize = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + " MB";

export function YouTubeUploadStatus({ item, onReview, onRemove }) {
  const progress = Math.round(item.uploaded_bytes * 100 / item.size) || 0;
  return <article className="youtube-upload-status">
    <FiFile /><div><strong>{item.title}</strong><small>{item.channel_name} · {PRIVACY[item.actual_privacy || item.privacy]}</small>
      {item.status === "uploading" && <><progress max="100" value={progress} aria-label="Progreso de subida a YouTube" /><small>Subiendo a YouTube… {progress}%</small></>}
      {item.status === "ready" && <small>Borrador listo · se conserva durante una hora.</small>}
      {item.status === "completed" && <><small><FiCheck /> Vídeo recibido. YouTube puede seguir procesándolo.</small>{item.actual_privacy && item.actual_privacy !== item.privacy && <small>YouTube ha aplicado privacidad «{PRIVACY[item.actual_privacy]}».</small>}</>}
      {item.error && <small className="message-error" role="alert">{item.error}</small>}
    </div><div className="youtube-upload-actions">
      {item.status === "ready" && <button className="compact-button" onClick={() => onReview(item)}>Revisar</button>}
      {item.url && <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label={`Abrir ${item.title} en YouTube`}><FiExternalLink /></a>}
      {item.status !== "uploading" && <button className="icon-button" onClick={() => onRemove(item.id)} aria-label={`Eliminar ${item.status === "ready" ? "borrador" : "registro"} ${item.title}`}><FiX /></button>}
    </div>
  </article>;
}

export default function YouTubePublisher({ draft = null, onClose, onChanged }) {
  const [file, setFile] = useState(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [privacy, setPrivacy] = useState("private");
  const [kids, setKids] = useState("");
  const [prepared, setPrepared] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function prepare(event) {
    event.preventDefault();
    if (!file || !file.size || file.size > 50 * 1024 * 1024) { setError("Elige un vídeo MP4, MOV o WebM de hasta 50 MB."); return; }
    setBusy(true); setError("");
    try {
      const item = await prepareYouTubeVideo(file, { title, description, privacy, made_for_kids: kids === "yes" });
      setPrepared(item); onChanged();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function publish() {
    setBusy(true); setError("");
    try { await publishYouTubeVideo(prepared.id); onChanged(); onClose(); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  async function edit() {
    setBusy(true); setError("");
    try { await discardYouTubeVideo(prepared.id); setPrepared(null); onChanged(); if (draft) onClose(); }
    catch (failure) { setError(failure.message); } finally { setBusy(false); }
  }
  const close = () => { if (!busy) { onChanged(); onClose(); } };
  return <Modal titleId="youtube-publisher-title" onClose={close} className="youtube-publisher">
    <header className="modal-heading"><div><span className="eyebrow">YOUTUBE</span><h2 id="youtube-publisher-title">{prepared ? "Revisa tu vídeo" : "Añadir vídeo"}</h2><p>{prepared ? "Confirma estos datos antes de subirlo a tu canal." : "Selecciona el archivo y decide cómo quieres compartirlo."}</p></div><button className="icon-button" onClick={close} disabled={busy} aria-label="Cerrar publicación de YouTube"><FiX /></button></header>
    {error && <p className="message-error" role="alert">{error}</p>}
    {prepared ? <div className="youtube-review">
      <dl><div><dt>Canal</dt><dd>{prepared.channel_name}</dd></div><div><dt>Archivo</dt><dd>{prepared.filename} · {uploadSize(prepared.size)}</dd></div><div><dt>Título</dt><dd>{prepared.title}</dd></div><div><dt>Visibilidad</dt><dd>{PRIVACY[prepared.privacy]}</dd></div><div><dt>Público infantil</dt><dd>{prepared.made_for_kids ? "Sí, creado para niños" : "No, no está creado para niños"}</dd></div>{prepared.description && <div><dt>Descripción</dt><dd className="youtube-description">{prepared.description}</dd></div>}</dl>
      <p className="muted">El vídeo preparado caduca en una hora. También puedes pedir a tu Dot que lo suba; te pedirá aprobación en el chat.</p>
      <footer className="youtube-review-buttons"><button className="text-button" disabled={busy} onClick={edit}><FiArrowLeft /> {draft ? "Descartar borrador" : "Editar"}</button><button className="compact-button" disabled={busy} onClick={close}>Guardar borrador</button><button className="primary-button" disabled={busy} onClick={publish}><FiUpload />{busy ? "Confirmando…" : "Confirmar y subir"}</button></footer>
    </div> : <form onSubmit={prepare} className="youtube-form">
      <label className="youtube-file"><FiUpload /><strong>{file ? file.name : "Selecciona tu vídeo"}</strong><small>{file ? uploadSize(file.size) : "MP4, MOV o WebM · máximo 50 MB"}</small><input aria-label="Archivo de vídeo" type="file" accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" required disabled={busy} onChange={(e) => { const next = e.target.files?.[0] || null; setFile(next); if (!title && next) setTitle(next.name.replace(/\.[^.]+$/, "").slice(0, 100)); }} /></label>
      <label>Título<input value={title} maxLength={100} required disabled={busy} onChange={(e) => setTitle(e.target.value)} placeholder="Dale un título a tu vídeo" /></label>
      <label>Descripción <span className="muted">(opcional)</span><textarea value={description} maxLength={5000} rows={3} disabled={busy} onChange={(e) => setDescription(e.target.value)} placeholder="Cuéntanos de qué trata…" /></label>
      <div className="youtube-form-row"><label>Visibilidad<select aria-label="Visibilidad" value={privacy} disabled={busy} onChange={(e) => setPrivacy(e.target.value)}>{Object.entries(PRIVACY).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>¿Está creado para niños?<select aria-label="¿Está creado para niños?" value={kids} required disabled={busy} onChange={(e) => setKids(e.target.value)}><option value="" disabled>Elige una opción</option><option value="no">No, no está creado para niños</option><option value="yes">Sí, creado para niños</option></select></label></div>
      <button type="submit" className="primary-button" disabled={busy || !file || !title.trim() || !kids}>{busy ? "Preparando vídeo…" : "Revisar subida"}<FiUpload /></button>
      <small className="muted">Todavía no se subirá a YouTube. En el siguiente paso verás el canal y confirmarás la subida.</small>
    </form>}
  </Modal>;
}
