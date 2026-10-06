"use client";
import { useEffect, useRef } from "react";

export default function Modal({
  children,
  onClose,
  titleId,
  className = "",
  sheet = false,
}) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const elements = () =>
      [
        ...ref.current.querySelectorAll(
          'button, a[href], input, select, textarea, summary, [tabindex="0"]',
        ),
      ].filter((el) => !el.disabled && el.getClientRects().length);
    (
      ref.current.querySelector("[autofocus]") ||
      elements()[0] ||
      ref.current
    ).focus();
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const list = elements();
        if (!list.length) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === list[0]) {
          event.preventDefault();
          list[list.length - 1].focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === list[list.length - 1]
        ) {
          event.preventDefault();
          list[0].focus();
        }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className={`modal-backdrop ${sheet ? "is-sheet" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`modal-surface ${className}`}
      >
        {children}
      </section>
    </div>
  );
}
