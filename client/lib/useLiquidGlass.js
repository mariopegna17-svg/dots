"use client";
import { useEffect, useRef } from "react";

// Reflect the pointer without React renders, and stop work on touch devices or
// whenever the system's reduced-motion preference is enabled.
export default function useLiquidGlass() {
  const root = useRef(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mouse = window.matchMedia("(hover: hover) and (pointer: fine)");
    let card = null;
    let point = null;
    let frame = 0;
    function reset() {
      window.cancelAnimationFrame(frame);
      frame = 0;
      point = null;
      if (card) {
        for (const property of ["--glass-x", "--glass-y", "--glass-rotate-x", "--glass-rotate-y"])
          card.style.removeProperty(property);
      }
      card = null;
    }
    function move(event) {
      if (reduced.matches || !mouse.matches || event.pointerType === "touch") return;
      const next = event.target.closest?.("[data-liquid-tilt]");
      if (!next || !element.contains(next)) { reset(); return; }
      if (card !== next) { reset(); card = next; }
      point = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!card || !point) return;
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.max(0, Math.min(1, (point.x - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (point.y - rect.top) / rect.height));
        card.style.setProperty("--glass-x", `${(x * 100).toFixed(1)}%`);
        card.style.setProperty("--glass-y", `${(y * 100).toFixed(1)}%`);
        card.style.setProperty("--glass-rotate-x", `${((0.5 - y) * 4).toFixed(2)}deg`);
        card.style.setProperty("--glass-rotate-y", `${((x - 0.5) * 4).toFixed(2)}deg`);
      });
    }
    element.addEventListener("pointermove", move, { passive: true });
    element.addEventListener("pointerleave", reset);
    reduced.addEventListener("change", reset);
    mouse.addEventListener("change", reset);
    return () => {
      reset();
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerleave", reset);
      reduced.removeEventListener("change", reset);
      mouse.removeEventListener("change", reset);
    };
  }, []);
  return root;
}
