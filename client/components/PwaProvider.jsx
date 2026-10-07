"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { applyAppearance, savedAppearance } from "../lib/appearance";

const PwaContext = createContext({ installed: false, ios: false, prompt: null, install: async () => false });
export const usePwa = () => useContext(PwaContext);

export default function PwaProvider({ children }) {
  const [installed, setInstalled] = useState(false);
  const [ios, setIos] = useState(false);
  const [prompt, setPrompt] = useState(null);
  useEffect(() => {
    applyAppearance(savedAppearance());
    const standalone = window.matchMedia('(display-mode: standalone)');
    const update = () => setInstalled(standalone.matches || Boolean(navigator.standalone));
    update();
    setIos(/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
    const beforeInstall = (event) => { event.preventDefault(); setPrompt(event); };
    const installedNow = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', installedNow);
    standalone.addEventListener('change', update);
    // Cache only the public icon/offline page; conversations and API responses are never cached.
    if ('serviceWorker' in navigator && window.isSecureContext && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => { /* The website remains usable when installation is unavailable. */ });
    }
    return () => { window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', installedNow); standalone.removeEventListener('change', update); };
  }, []);
  async function install() {
    if (!prompt) return false;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    setPrompt(null);
    return choice.outcome === 'accepted';
  }
  return <PwaContext.Provider value={{ installed, ios, prompt, install }}>{children}</PwaContext.Provider>;
}
