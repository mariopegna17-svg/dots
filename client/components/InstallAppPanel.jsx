"use client";
import Image from "next/image";
import { FiDownload, FiPlusSquare, FiShare } from "react-icons/fi";
import { useState } from "react";
import { usePwa } from "./PwaProvider";

export default function InstallAppPanel() {
  const { installed, ios, prompt, install } = usePwa();
  const [notice, setNotice] = useState("");
  return <section className="settings-card install-app-panel">
    <div className="install-app-heading"><Image src="/app-icon.png" width={68} height={68} alt="Icono Dots de cristal transparente" unoptimized /><div><h3>Dots en tu pantalla de inicio</h3><p>Ábrelo como una app, con su propio icono Liquid Glass.</p></div></div>
    {installed ? <p role="status" className="install-app-status">Ya lo estás usando como app.</p> : <>
      {prompt && !ios && <button className="primary-button" onClick={async () => { try { setNotice(await install() ? "Instalación aceptada." : "Puedes instalarla más tarde desde el navegador."); } catch { setNotice("Usa la opción Instalar del menú de tu navegador."); } }}><FiDownload /> Instalar Dots</button>}
      <ol><li>Abre tu web de Dots en <strong>{ios ? "Safari" : "Safari en el iPhone"}</strong>.</li><li>Pulsa <FiShare /> <strong>Compartir</strong> en el menú del navegador.</li><li>Elige <FiPlusSquare /> <strong>Añadir a pantalla de inicio</strong>. Activa «Abrir como app» si aparece y pulsa <strong>Añadir</strong>.</li></ol>
      {!ios && !prompt && <p className="muted">En Android o en el ordenador, usa «Instalar aplicación» en el menú del navegador cuando esté disponible.</p>}
      <small>La sesión del icono puede ser independiente de Safari: entra con tu clave de acceso si te la pide. Tus Dots necesitan conexión a internet.</small>
    </>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
