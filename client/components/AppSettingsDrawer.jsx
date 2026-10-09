"use client";

import React, { useState, useEffect } from "react";
import {
  FiX,
  FiEye,
  FiEyeOff,
  FiPlus,
  FiTrash2,
  FiChevronDown,
} from "react-icons/fi";
import Modal from "./Modal";
import AppearancePanel from "./AppearancePanel";
import InstallAppPanel from "./InstallAppPanel";
import PersistencePanel from "./PersistencePanel";
import { fetchSettings, saveSettings } from "../lib/api";

const inputClass = "studio-input";
const cardClass = "settings-card";
const buttonClass = "primary-button";

export default function AppSettingsDrawer({
  models,
  isOpen,
  onClose,
  currentModel,
  onUpdateDefaultModel,
  onProfileUpdate,
  bot,
  onUpdateRules,
  onOpenConnectors,
}) {
  const [rules, setRules] = useState("");
  const [rulesNotice, setRulesNotice] = useState("");
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [wireApi, setWireApi] = useState("chat_completions");
  const [apiKey, setApiKey] = useState("");
  const [keyConfiguradas, setKeyConfiguradas] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [modelIds, setModelIds] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [responseMode, setResponseMode] = useState("fast");
  const [responseModeSaving, setResponseModeSaving] = useState(false);
  const [responseModeNotice, setResponseModeNotice] = useState("");
  const [whatsappSendMode, setWhatsappSendMode] = useState("automatic");
  const [whatsappModeSaving, setWhatsappModeSaving] = useState(false);
  const [whatsappModeNotice, setWhatsappModeNotice] = useState("");
  const [headersConfiguradas, setHeadersConfiguradas] = useState(false);
  const [headersMode, setHeadersMode] = useState("keep");
  const [headers, setHeaders] = useState([{ name: "", value: "" }]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    setRules(bot?.system_prompt || "");
    setRulesNotice("");
  }, [bot?.id, bot?.system_prompt, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoaded(false);
    setNotice(null);
    setApiKey("");
    setShowKey(false);
    setUserName(localStorage.getItem("open_dots_user_name") || "");
    setUserEmail(localStorage.getItem("open_dots_user_email") || "");
    fetchSettings().then((data) => {
      if (cancelled) return;
      if (!data) {
        setNotice({
          error: true,
          text: "No se pudieron cargar los ajustes. Vuelve a abrir el panel.",
        });
        return;
      }
      setBaseUrl(data.model_api_base_url || "");
      setWireApi(data.model_api_wire_api || "chat_completions");
      setKeyConfiguradas(Boolean(data.model_api_key_configured));
      setModelIds((data.model_ids || []).join("\n"));
      setDefaultModel(data.default_model || currentModel || "gpt-5-mini");
      setResponseMode(data.model_response_mode || "fast");
      setResponseModeNotice("");
      setWhatsappSendMode(data.whatsapp_send_mode || "automatic");
      setWhatsappModeNotice("");
      setHeadersConfiguradas(Boolean(data.model_api_headers_configured));
      setHeadersMode("keep");
      setHeaders([{ name: "", value: "" }]);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // Reload when opening, without overwriting a draft when the active model changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  if (!isOpen) return null;

  const saveProvider = async (event) => {
    event.preventDefault();
    setNotice(null);
    setSaving(true);
    try {
      const url = new URL(baseUrl.trim());
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error(
          "Introduce una URL http(s) sin credenciales ni parámetros.",
        );
      }
      const selectedModel = defaultModel.trim();
      if (!selectedModel)
        throw new Error("Introduce el ID del modelo predeterminado.");
      const ids = [
        ...new Set([
          ...modelIds
            .split(/[\n,]+/)
            .map((id) => id.trim())
            .filter(Boolean),
          selectedModel,
        ]),
      ];
      const payload = {
        model_api_base_url: baseUrl.trim().replace(/\/+$/, ""),
        model_api_wire_api: wireApi,
        model_api_key: apiKey.trim(),
        model_ids: ids,
        default_model: selectedModel,
      };
      if (headersMode === "replace") {
        const entries = headers.map(({ name, value }) => [name.trim(), value]);
        if (
          !entries.length ||
          entries.some(([name, value]) => !name || !value)
        ) {
          throw new Error(
            "Completa el nombre y valor de cada cabecera, o elige eliminar todas.",
          );
        }
        if (
          new Set(entries.map(([name]) => name.toLowerCase())).size !==
          entries.length
        ) {
          throw new Error("Cada cabecera debe tener un nombre único.");
        }
        payload.model_api_headers = Object.fromEntries(entries);
      } else if (headersMode === "remove") {
        payload.clear_model_api_headers = true;
      }
      const saved = await saveSettings(payload);
      setBaseUrl(saved.model_api_base_url);
      setApiKey("");
      setShowKey(false);
      setKeyConfiguradas(Boolean(saved.model_api_key_configured));
      setHeadersConfiguradas(Boolean(saved.model_api_headers_configured));
      setHeadersMode("keep");
      setHeaders([{ name: "", value: "" }]);
      setModelIds(saved.model_ids.join("\n"));
      setDefaultModel(saved.default_model);
      await onUpdateDefaultModel?.(saved.default_model);
      setNotice({ text: "Proveedor guardado. Modelos actualizados." });
    } catch (error) {
      setNotice({
        error: true,
        text: error.message || "No se pudo guardar el proveedor.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onClose={onClose} titleId="settings-title" sheet>
      <div className="settings-sheet">
        <div className="settings-header">
          <div>
            <h2 id="settings-title">A tu manera.</h2>
            <p>Un espacio que se adapta a ti.</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar ajustes"
            className="icon-button"
          >
            <FiX />
          </button>
        </div>
        <div className="settings-body">
          <AppearancePanel />
          <InstallAppPanel />
          <PersistencePanel />
          <section className={`${cardClass} response-mode-settings`} aria-labelledby="response-mode-title">
            <h3 id="response-mode-title">Velocidad de respuesta</h3>
            <p>Elige cómo quieres conversar con tus Dots.</p>
            <fieldset disabled={!loaded || responseModeSaving}>
              <legend className="sr-only">Modo de respuesta</legend>
              {[{ value: "fast", label: "Rápida", description: "Para conversar y resolver tareas cotidianas." }, { value: "reasoned", label: "Razonamiento", description: "Dedica más tiempo a los problemas complejos." }].map((mode) => (
                <label key={mode.value} className={responseMode === mode.value ? "is-selected" : ""}>
                  <input type="radio" name="response-mode" value={mode.value} checked={responseMode === mode.value} onChange={async () => {
                    setResponseModeSaving(true);
                    setResponseModeNotice("");
                    try {
                      const saved = await saveSettings({ model_response_mode: mode.value });
                      setResponseMode(saved.model_response_mode);
                      setResponseModeNotice(`Modo ${mode.label.toLowerCase()} guardado.`);
                    } catch (failure) {
                      setResponseModeNotice(failure.message || "No se pudo guardar el modo.");
                    } finally {
                      setResponseModeSaving(false);
                    }
                  }} />
                  <span><strong>{mode.label}</strong><small>{mode.description}</small></span>
                </label>
              ))}
            </fieldset>
            {responseModeNotice && <p role="status">{responseModeNotice}</p>}
          </section>
          <section className={`${cardClass} whatsapp-mode-settings`} aria-labelledby="whatsapp-mode-title">
            <h3 id="whatsapp-mode-title">Envíos a mi WhatsApp</h3>
            <label>
              <input type="checkbox" checked={whatsappSendMode === "automatic"} disabled={!loaded || whatsappModeSaving} onChange={async (event) => {
                const mode = event.target.checked ? "automatic" : "review";
                setWhatsappModeSaving(true);
                setWhatsappModeNotice("");
                try {
                  const saved = await saveSettings({ whatsapp_send_mode: mode });
                  setWhatsappSendMode(saved.whatsapp_send_mode);
                  setWhatsappModeNotice(mode === "automatic" ? "Envío automático activado." : "Revisión antes de enviar activada.");
                } catch (failure) {
                  setWhatsappModeNotice(failure.message || "No se pudo guardar tu preferencia.");
                } finally {
                  setWhatsappModeSaving(false);
                }
              }} />
              <span><strong>Enviar sin pedirme confirmación</strong><small>Los mensajes que le pidas al Dot se envían a tu número vinculado. Desactívalo para revisar cada envío en el chat.</small></span>
            </label>
            {whatsappModeNotice && <p role="status">{whatsappModeNotice}</p>}
          </section>
          {bot && (
            <form
              className={cardClass}
              onSubmit={async (e) => {
                e.preventDefault();
                setRulesNotice("");
                try {
                  await onUpdateRules(bot.id, rules);
                  setRulesNotice("Reglas guardadas.");
                } catch (error) {
                  setRulesNotice(error.message);
                }
              }}
            >
              <h3 className="text-sm font-semibold">Reglas de {bot.name}</h3>
              <p className="text-xs text-zinc-400">
                Define sus objetivos, estilo y límites. Los permisos de acciones
                siguen aplicándose.
              </p>
              <textarea
                aria-label="Reglas del agente"
                className={inputClass}
                rows={5}
                required
                maxLength={12000}
                value={rules}
                onChange={(e) => setRules(e.target.value)}
              />
              <button className={buttonClass}>Guardar reglas</button>
              {rulesNotice && (
                <p role="status" className="text-xs text-violet-300">
                  {rulesNotice}
                </p>
              )}
            </form>
          )}
          <details className={`${cardClass} group`}>
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400">
              <span className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-zinc-100">
                  Proveedor de IA
                </span>
                <FiChevronDown
                  aria-hidden="true"
                  className="text-zinc-400 transition-transform group-open:rotate-180"
                />
              </span>
              <span className="block text-xs text-zinc-400 mt-1 break-words">
                {loaded
                  ? `${wireApi === "chat_completions" ? "NVIDIA / Chat Completions" : wireApi === "responses" ? "Responses API" : "Prediction API"} · ${defaultModel}`
                  : "Conecta el motor de tus Dots"}
              </span>
              <span className="block text-[11px] text-violet-300 mt-2">
                Configurar NVIDIA o proveedor
              </span>
            </summary>
            <form
              onSubmit={saveProvider}
              onChange={() => setNotice(null)}
              className="space-y-4 border-t border-[#27272a] pt-4"
            >
              <p className="text-xs text-zinc-400">
                Configura NVIDIA NIM o un proveedor compatible. La clave se
                cifra en el servidor.
              </p>
              <button
                type="button"
                className={buttonClass}
                onClick={() => {
                  setBaseUrl("https://integrate.api.nvidia.com/v1");
                  setWireApi("chat_completions");
                  setModelIds("nvidia/nemotron-3-super-120b-a12b");
                  setDefaultModel("nvidia/nemotron-3-super-120b-a12b");
                }}
              >
                Usar NVIDIA NIM
              </button>
              {!loaded && !notice && (
                <p role="status" className="text-xs text-zinc-400">
                  Cargando ajustes…
                </p>
              )}
              <fieldset
                disabled={!loaded || saving}
                className="space-y-4 disabled:opacity-60"
              >
                <div className="space-y-1.5">
                  <label
                    htmlFor="provider-url"
                    className="block text-xs font-medium"
                  >
                    URL base de la API
                  </label>
                  <input
                    id="provider-url"
                    type="url"
                    required
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://your-provider.example/v1"
                    className={inputClass}
                  />
                  <p className="text-[11px] text-zinc-500">
                    Introduce la raíz de la API terminada en /v1, sin añadir
                    /chat/completions.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="provider-protocol"
                    className="block text-xs font-medium"
                  >
                    Protocolo
                  </label>
                  <select
                    id="provider-protocol"
                    value={wireApi}
                    onChange={(e) => setWireApi(e.target.value)}
                    className={inputClass}
                  >
                    <option value="chat_completions">
                      NVIDIA / Chat Completions
                    </option>
                    <option value="responses">Responses API</option>
                    <option value="prediction">
                      Prediction API (original adapter)
                    </option>
                  </select>
                  <p className="text-[11px] text-zinc-500">
                    {wireApi === "chat_completions"
                      ? "NVIDIA NIM: /chat/completions con autenticación Bearer. El modelo debe admitir herramientas para ejecutar acciones."
                      : wireApi === "responses"
                        ? "Uses /responses with Bearer authentication. Compatible with Responses services."
                        : "Uses /{model_id} and prediction polling with x-api-key authentication."}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="provider-key"
                    className="block text-xs font-medium"
                  >
                    Clave API de NVIDIA
                  </label>
                  <div className="relative">
                    <input
                      id="provider-key"
                      type={showKey ? "text" : "password"}
                      autoComplete="new-password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={
                        keyConfiguradas
                          ? "Guardada de forma segura; deja vacío para conservar"
                          : "Introduce tu clave API"
                      }
                      className={`${inputClass} pr-10`}
                    />
                    <button
                      type="button"
                      title={showKey ? "Ocultar clave" : "Mostrar clave"}
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-3 text-zinc-400"
                    >
                      {showKey ? <FiEyeOff /> : <FiEye />}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="provider-models"
                    className="block text-xs font-medium"
                  >
                    Modelos disponibles
                  </label>
                  <textarea
                    id="provider-models"
                    rows={3}
                    value={modelIds}
                    onChange={(e) => setModelIds(e.target.value)}
                    placeholder="Un ID de modelo por línea"
                    className={`${inputClass} font-mono resize-y`}
                  />
                  <p className="text-[11px] text-zinc-500">
                    Usa los IDs exactos de NVIDIA, uno por línea o separados por
                    comas.
                  </p>
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="provider-default-model"
                    className="block text-xs font-medium"
                  >
                    Modelo predeterminado
                  </label>
                  <input
                    id="provider-default-model"
                    required
                    value={defaultModel}
                    onChange={(e) => setDefaultModel(e.target.value)}
                    list="provider-model-options"
                    className={inputClass}
                  />
                  <datalist id="provider-model-options">
                    {[
                      ...new Set([
                        ...modelIds
                          .split(/[\n,]+/)
                          .map((id) => id.trim())
                          .filter(Boolean),
                        ...(models || []).map((model) => model.id),
                      ]),
                    ].map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                  <p className="text-[11px] text-zinc-500">
                    Se usa para nuevos agentes. Cada agente conserva el modelo
                    que hayas elegido.
                  </p>
                </div>
                <details className="border border-[#36363d] rounded-lg p-3">
                  <summary className="cursor-pointer text-xs font-medium">
                    Cabeceras personalizadas ·{" "}
                    {headersConfiguradas ? "Configuradas" : "Opcional"}
                  </summary>
                  <div className="mt-3 space-y-3">
                    <label
                      htmlFor="provider-header-action"
                      className="block text-xs text-zinc-400"
                    >
                      Acción
                    </label>
                    <select
                      id="provider-header-action"
                      value={headersMode}
                      onChange={(e) => setHeadersMode(e.target.value)}
                      className={inputClass}
                    >
                      <option value="keep">Conservar las guardadas</option>
                      <option value="replace">Reemplazar todas</option>
                      <option value="remove">Eliminar todas</option>
                    </select>
                    <p className="text-[11px] text-zinc-500">
                      Los valores se guardan cifrados. Para reemplazarlos,
                      introduce el conjunto completo.
                    </p>
                    {headersMode === "replace" && (
                      <>
                        {headers.map((header, index) => (
                          <div
                            key={index}
                            className="space-y-2 rounded-lg bg-[#111113] p-2"
                          >
                            <input
                              aria-label={`Nombre de cabecera ${index + 1}`}
                              value={header.name}
                              onChange={(e) =>
                                setHeaders(
                                  headers.map((row, i) =>
                                    i === index
                                      ? { ...row, name: e.target.value }
                                      : row,
                                  ),
                                )
                              }
                              placeholder="Nombre de cabecera"
                              className={inputClass}
                            />
                            <div className="flex gap-2">
                              <input
                                aria-label={`Valor de cabecera ${index + 1}`}
                                type="password"
                                autoComplete="new-password"
                                value={header.value}
                                onChange={(e) =>
                                  setHeaders(
                                    headers.map((row, i) =>
                                      i === index
                                        ? { ...row, value: e.target.value }
                                        : row,
                                    ),
                                  )
                                }
                                placeholder="Valor de cabecera"
                                className={inputClass}
                              />
                              <button
                                type="button"
                                title={`Eliminar cabecera ${index + 1}`}
                                onClick={() =>
                                  setHeaders(
                                    headers.filter((_, i) => i !== index),
                                  )
                                }
                                className="p-2 text-zinc-400 hover:text-red-400"
                              >
                                <FiTrash2 />
                              </button>
                            </div>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() =>
                            setHeaders([...headers, { name: "", value: "" }])
                          }
                          className="flex items-center gap-1 text-xs text-violet-300"
                        >
                          <FiPlus /> Añadir cabecera
                        </button>
                      </>
                    )}
                  </div>
                </details>
                <button type="submit" className={`${buttonClass} w-full`}>
                  {saving ? "Guardando…" : "Guardar proveedor"}
                </button>
              </fieldset>
              {notice && (
                <p
                  role={notice.error ? "alert" : "status"}
                  className={`text-xs ${notice.error ? "text-red-400" : "text-emerald-400"}`}
                >
                  {notice.text}
                </p>
              )}
            </form>
          </details>

          <section className={cardClass}>
            <h3 className="text-sm font-semibold">
              Conectores de aplicaciones
            </h3>
            <p className="text-xs text-zinc-400">YouTube, GitHub y tus demás cuentas se configuran paso a paso en Conectores.</p>
            <button type="button" className={buttonClass} onClick={onOpenConnectors}>Abrir conectores</button>
          </section>

          <div className={cardClass}>
            <h3 className="text-sm font-semibold">Perfil</h3>
            <p className="text-xs text-zinc-400">
              Tu nombre se guarda automáticamente en este navegador.
            </p>
            <label htmlFor="profile-name" className="block text-xs font-medium">
              Tu nombre
            </label>
            <input
              id="profile-name"
              value={userName}
              onChange={(e) => {
                setUserName(e.target.value);
                localStorage.setItem("open_dots_user_name", e.target.value);
                onProfileUpdate?.(e.target.value);
              }}
              className={inputClass}
            />
            <label
              htmlFor="profile-email"
              className="block text-xs font-medium"
            >
              Email
            </label>
            <input
              id="profile-email"
              type="email"
              value={userEmail}
              onChange={(e) => {
                setUserEmail(e.target.value);
                localStorage.setItem("open_dots_user_email", e.target.value);
              }}
              className={inputClass}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
