"use client";

import { useEffect } from "react";

/** Keep the composer above the on-screen keyboard, including Safari's visual viewport. */
export default function useAppViewport() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let frame = 0;
    const update = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        // Pinch zoom should remain usable; only resize the app at normal scale.
        if (viewport.scale !== 1) return;
        document.documentElement.style.setProperty("--app-viewport-height", `${Math.round(viewport.height)}px`);
      });
    };
    update();
    viewport.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      document.documentElement.style.removeProperty("--app-viewport-height");
    };
  }, []);
}
