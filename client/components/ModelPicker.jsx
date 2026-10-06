"use client";
import { useState, useRef, useEffect, useMemo } from "react";
import { FiChevronDown, FiCheck, FiCpu } from "react-icons/fi";

export const ALL_PROVIDERS = [];
export function getProviders(models) {
  const groups = new Map();
  for (const model of models || []) {
    if (model.is_available === false) continue;
    const name =
      model.provider && model.provider !== "Configured provider"
        ? model.provider
        : "Tu proveedor de IA";
    if (!groups.has(name)) groups.set(name, { id: name, name, models: [] });
    groups.get(name).models.push(model);
  }
  return [...groups.values()];
}
export function findModel(id, providers = ALL_PROVIDERS) {
  for (const provider of providers) {
    const model = provider.models.find((item) => item.id === id);
    if (model) return { provider, model };
  }
  return null;
}
function shortName(name) {
  return (name || "").split("/").pop().replace(/-/g, " ");
}
export default function ModelPicker({ currentModel, onSelectModel, models }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const providers = useMemo(() => getProviders(models), [models]);
  const current = findModel(currentModel, providers);
  useEffect(() => {
    if (!isOpen) return;
    function close(event) {
      if (event.type === "keydown" && event.key === "Escape") {
        setIsOpen(false);
        triggerRef.current?.focus();
      } else if (
        event.type === "mousedown" &&
        ref.current &&
        !ref.current.contains(event.target)
      )
        setIsOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [isOpen]);
  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        className="model-trigger"
        aria-label="Elegir modelo de IA"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        title={currentModel}
      >
        <FiCpu />
        <span>
          {shortName(current?.model.name || currentModel) || "Elegir modelo"}
        </span>
        <FiChevronDown />
      </button>
      {isOpen && (
        <div className="model-popover">
          <div className="model-popover-header">
            <FiCpu />
            Modelo de esta conversación
          </div>
          {providers.length ? (
            providers.map((provider) => (
              <div key={provider.id}>
                {provider.models.map((model) => (
                  <button
                    key={model.id}
                    className={`model-option ${model.id === currentModel ? "selected" : ""}`}
                    aria-pressed={model.id === currentModel}
                    onClick={() => {
                      onSelectModel(model.id);
                      setIsOpen(false);
                      triggerRef.current?.focus();
                    }}
                  >
                    <span>
                      {shortName(model.name || model.id)}
                      <small>{provider.name}</small>
                    </span>
                    {model.id === currentModel && <FiCheck />}
                  </button>
                ))}
              </div>
            ))
          ) : (
            <p className="model-empty">
              Añade los modelos de tu proveedor en Ajustes.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
