"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import MessageItem from "./MessageItem";
import ApprovalCard from "./ApprovalCard";
import ModelPicker from "./ModelPicker";
import MascotAvatar, { botTone } from "./MascotAvatar";
import { agentLabel } from "./Overview";
import {
  FiMic,
  FiMicOff,
  FiMonitor,
  FiX,
  FiImage,
  FiArrowUp,
  FiSquare,
  FiArrowUpRight,
  FiCpu,
} from "react-icons/fi";
import {
  sendMessage,
  subscribeToChatStream,
  uploadImage,
  respondApproval,
  fetchChatHistory,
} from "../lib/api";

function formatHeaderDate(msgs) {
  const firstWithDate = msgs?.find((m) => m.created_at);
  if (!firstWithDate || !firstWithDate.created_at) {
    return "Hoy";
  }
  const d = new Date(firstWithDate.created_at);
  if (isNaN(d.getTime())) return "Hoy";

  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return "Hoy";
  }

  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return "Ayer";
  }

  return d.toLocaleDateString("es-ES", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function ChatWindow({
  bot,
  models,
  messages,
  setMessages,
  onUpdateBotModel,
  onToggleComputer,
  defaultModel,
  draft,
  historyLoading,
}) {
  const [inputPrompt, setInputPrompt] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingMessageId, setStreamingMessageId] = useState(null);
  const [isListening, setIsListening] = useState(false);
  const [activeModel, setActiveModel] = useState(
    bot?.model || defaultModel || "gpt-5-mini",
  );
  const [selectedImage, setSelectedImage] = useState(null);
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [toolEvents, setToolEvents] = useState([]);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const streamRef = useRef(null);
  const textareaRef = useRef(null);
  const recognitionRef = useRef(null);
  const [notice, setNotice] = useState("");
  const [voiceSupported, setVoiceSupported] = useState(false);

  useEffect(() => {
    setVoiceSupported(
      Boolean(window.SpeechRecognition || window.webkitSpeechRecognition),
    );
  }, []);
  useEffect(() => {
    if (draft?.botId === bot?.id) {
      setInputPrompt(draft.text);
    }
  }, [draft, bot?.id]);
  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height =
      Math.min(textareaRef.current.scrollHeight, 180) + "px";
  }, [inputPrompt]);

  useEffect(() => {
    setIsStreaming(false);
    setStreamingMessageId(null);
    setPendingApprovals([]);
    setToolEvents([]);
    setNotice("");
    setSelectedImage(null);
    return () => {
      streamRef.current?.();
      streamRef.current = null;
      recognitionRef.current?.stop();
    };
  }, [bot?.id]);

  useEffect(() => {
    if (!bot?.id || isStreaming) return;
    let disposed = false;
    const timer = window.setInterval(async () => {
      try {
        const history = await fetchChatHistory(bot.id);
        if (!disposed) setMessages(history);
      } catch (failure) {
        if (!disposed) setNotice("No se pudo actualizar la conversación.");
      }
    }, 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [bot?.id, isStreaming, setMessages]);

  const botTitle = bot?.name || "Open Dots Assistant";

  const activeMessages = useMemo(() => messages || [], [messages]);
  const streamingMessage = activeMessages.find(
    (message) => message.id === streamingMessageId,
  );
  const mascotActivity = pendingApprovals.length
    ? "idle"
    : isStreaming
    ? streamingMessage?.text
      ? "responding"
      : "thinking"
    : isListening
      ? "listening"
      : "idle";
  const whatsappSending = isStreaming && toolEvents.at(-1)?.type === "tool.started" && ["whatsapp_owner", "communication.whatsapp_qr", "communication.whatsapp"].includes(toolEvents.at(-1)?.tool);
  const activityLabel = pendingApprovals.length
    ? "Esperando tu autorización"
    : whatsappSending
    ? "Enviando a WhatsApp…"
    : {
        thinking: "Pensando…",
        responding: "Escribiendo…",
        listening: "Te escucho…",
      }[mascotActivity];

  useEffect(() => {
    if (bot?.model) {
      setActiveModel(bot.model);
    } else if (defaultModel) {
      setActiveModel(defaultModel);
    }
  }, [bot, defaultModel]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    if (activeMessages.length) scrollToBottom();
  }, [activeMessages, isStreaming]);

  const handleModelChange = async (newModel) => {
    try {
      if (onUpdateBotModel && bot?.id) await onUpdateBotModel(bot.id, newModel);
      setActiveModel(newModel);
    } catch (failure) {
      setNotice(failure.message || "No se pudo cambiar el modelo.");
    }
  };

  const handleApprovalResponse = async (requestId, action) => {
    try {
      await respondApproval(requestId, action);
      setPendingApprovals(previous => previous.filter(approval => approval.requestId !== requestId));
    } catch (failure) {
      if (failure.status === 404) {
        setPendingApprovals(previous => previous.filter(approval => approval.requestId !== requestId));
        setNotice(failure.message);
      }
      throw failure;
    }
  };

  const handleImageSelect = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Strict IMAGE ONLY validation
    if (!file.type.startsWith("image/")) {
      setNotice("Elige un archivo de imagen.");
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setSelectedImage({
      file,
      previewUrl,
      isUploading: true,
      uploadedUrl: null,
      error: null,
    });

    try {
      const res = await uploadImage(file);
      setSelectedImage((prev) =>
        prev ? { ...prev, isUploading: false, uploadedUrl: res.url } : null,
      );
    } catch (err) {
      console.error("Failed to upload image:", err);
      setSelectedImage((prev) =>
        prev ? { ...prev, isUploading: false, error: err.message } : null,
      );
    }
  };

  const handleSendMessage = async (e) => {
    e?.preventDefault();
    if (
      (!inputPrompt.trim() && !selectedImage) ||
      isStreaming ||
      !bot?.id ||
      selectedImage?.isUploading ||
      selectedImage?.error
    )
      return;
    setNotice("");
    setToolEvents([]);
    setPendingApprovals([]);

    const userText = inputPrompt;
    const currentSelected = selectedImage;

    setInputPrompt("");
    setSelectedImage(null);

    let finalImageUrl = currentSelected?.uploadedUrl || null;

    // Ensure image upload finishes before dispatching to the inference backend
    if (currentSelected && !finalImageUrl) {
      try {
        const res = await uploadImage(currentSelected.file);
        finalImageUrl = res.url;
      } catch (err) {
        console.error("Image upload failed on send:", err);
      }
    }

    const userMsgObj = {
      id: `temp-user-${Date.now()}`,
      sender: "user",
      text: userText,
      image_url: currentSelected?.previewUrl || finalImageUrl,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsgObj]);

    try {
      if (bot?.id) {
        setStreamingMessageId(null);
        setIsStreaming(true);
        const sent = await sendMessage(
          bot.id,
          bot.id,
          userText,
          activeModel,
          finalImageUrl,
        );
        if (sent.status !== "ok")
          throw new Error(sent.detail || "No se pudo enviar el mensaje.");
        let streamingMsgId = null;

        streamRef.current = subscribeToChatStream(
          bot.id,
          activeModel,
          (event) => {
            if (event.type === "turn.started") {
              streamingMsgId = event.botMsgId;
              setStreamingMessageId(event.botMsgId);
              setMessages((prev) => [
                ...prev,
                {
                  id: streamingMsgId,
                  sender: "bot",
                  text: "",
                  created_at: new Date().toISOString(),
                },
              ]);
            } else if (event.type === "request.opened") {
              if (window.matchMedia("(pointer: coarse)").matches) textareaRef.current?.blur();
              setPendingApprovals((prev) => [
                ...prev.filter(
                  (approval) => approval.requestId !== event.requestId,
                ),
                event,
              ]);
            } else if (
              [
                "tool.started",
                "tool.completed",
                "tool.failed",
                "tool.denied",
                "tool.expired",
              ].includes(event.type)
            ) {
              setToolEvents((prev) => [
                ...prev.slice(-4),
                { ...event, id: `${event.type}-${Date.now()}` },
              ]);
              if (["tool.expired", "tool.denied", "tool.completed", "tool.failed"].includes(event.type) && event.requestId) {
                setPendingApprovals((prev) =>
                  prev.filter(
                    (approval) => approval.requestId !== event.requestId,
                  ),
                );
              }
            } else if (event.type === "content.delta") {
              setMessages((prev) =>
                prev.map((msg) =>
                  msg.id === streamingMsgId
                    ? { ...msg, text: msg.text + event.delta }
                    : msg,
                ),
              );
            } else if (event.type === "turn.completed") {
              setIsStreaming(false);
              setPendingApprovals([]);
              if (event.ok === false)
                setMessages((prev) =>
                  prev.map((msg) =>
                    msg.id === streamingMsgId ? { ...msg, isError: true } : msg,
                  ),
                );
            }
          },
          () => {
            setIsStreaming(false);
            setPendingApprovals([]);
            setNotice("La conexión se interrumpió. Si ya autorizaste un envío, comprueba WhatsApp antes de repetirlo.");
          },
        );
      }
    } catch (err) {
      setNotice(
        err.message || "No se pudo enviar el mensaje. Inténtalo de nuevo.",
      );
      setIsStreaming(false);
      setPendingApprovals([]);
    }
  };

  const handleVoiceToggle = () => {
    if (
      !("webkitSpeechRecognition" in window) &&
      !("SpeechRecognition" in window)
    ) {
      setNotice("El dictado no está disponible en este navegador.");
      return;
    }

    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
    } else {
      try {
        const SpeechRecognition =
          window.SpeechRecognition || window.webkitSpeechRecognition;
        const recognition = new SpeechRecognition();
        recognitionRef.current = recognition;
        recognition.lang = "es-ES";
        recognition.continuous = false;
        recognition.onstart = () => setIsListening(true);
        recognition.onresult = (event) => {
          const transcript = event.results[0][0].transcript;
          setInputPrompt((prev) => prev + (prev ? " " : "") + transcript);
          setIsListening(false);
        };
        recognition.onerror = () => setIsListening(false);
        recognition.onend = () => setIsListening(false);
        recognition.start();
      } catch (err) {
        setIsListening(false);
      }
    }
  };

  function stopResponse() {
    streamRef.current?.();
    streamRef.current = null;
    setIsStreaming(false);
    setPendingApprovals([]);
  }
  const suggestions = [
    "Ayúdame a organizar una idea",
    "Explícame algo que quiero aprender",
    "Pensemos mi próximo paso",
  ];
  const toolLabels = {
    started: "En curso",
    completed: "Completado",
    failed: "Error",
    denied: "No autorizado",
    expired: "Expirado",
  };
  return (
    <div className="chat-workspace">
      <header className="chat-agent-header">
        <div className="chat-agent-identity">
          <MascotAvatar
            type={botTone(bot)}
            size="md"
            activity={mascotActivity}
          />
          <div>
            <h2>{botTitle}</h2>
            <p aria-live="polite">{activityLabel || agentLabel(bot)}</p>
          </div>
        </div>
        <div className="chat-header-actions">
          <ModelPicker
            models={models}
            currentModel={activeModel}
            onSelectModel={handleModelChange}
          />
          <button
            onClick={onToggleComputer}
            className="icon-button"
            aria-label="Abrir ordenador del agente"
            title="Ordenador del agente"
          >
            <FiMonitor />
          </button>
        </div>
      </header>
      <div className="chat-thread">
        <div className="chat-thread-inner">
          {historyLoading ? (
            <p role="status" className="muted">
              Cargando tu conversación…
            </p>
          ) : activeMessages.length === 0 ? (
            <div className="chat-empty">
              <MascotAvatar type={botTone(bot)} size="xl" activity="greeting" />
              <h1>¿En qué te ayudo?</h1>
              <p>Habla con {botTitle} sobre lo que necesites.</p>
              <div className="chat-suggestions">
                {suggestions.map((text) => (
                  <button
                    key={text}
                    onClick={() => {
                      setInputPrompt(text);
                      textareaRef.current?.focus();
                    }}
                  >
                    {text}
                    <FiArrowUpRight />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="thread-date">
                {formatHeaderDate(activeMessages)}
              </div>
              {toolEvents.map((event) => (
                <details key={event.id} className="tool-event">
                  <summary>
                    <FiCpu />
                    <span>
                      {{
                        call_owner: "Llamada a tu teléfono",
                        whatsapp_owner: "Mensaje de WhatsApp",
                        communication_status: "Estado de WhatsApp y llamadas",
                      }[event.tool] ||
                        event.tool ||
                        "Herramienta"}
                    </span>
                    <span>{toolLabels[event.type.replace("tool.", "")]}</span>
                  </summary>
                  {event.error && <p className="inline-error">{event.error}</p>}
                  {event.result && (
                    <pre>{JSON.stringify(event.result, null, 2)}</pre>
                  )}
                </details>
              ))}
              {activeMessages.map((msg) => (
                <MessageItem
                  key={msg.id}
                  message={msg}
                  bot={bot}
                  activity={
                    isStreaming && msg.id === streamingMessageId
                      ? mascotActivity
                      : "idle"
                  }
                />
              ))}
            </>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>
      <div className="composer-area">
        <div className="composer-inner">
          {pendingApprovals.length > 0 && (
            <div className="chat-action-reviews" aria-label="Acciones pendientes de autorización">
              {pendingApprovals.map(approval => (
                <ApprovalCard key={approval.requestId} approval={approval} onRespond={handleApprovalResponse} />
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleImageSelect}
            className="hidden"
          />
          {selectedImage && (
            <div className="attachment-preview">
              <img src={selectedImage.previewUrl} alt="Imagen seleccionada" />
              <div>
                <strong>{selectedImage.file.name}</strong>
                <small>
                  {selectedImage.isUploading
                    ? "Subiendo imagen…"
                    : selectedImage.error
                      ? selectedImage.error
                      : "Imagen preparada"}
                </small>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setSelectedImage(null)}
                aria-label="Quitar imagen"
              >
                <FiX />
              </button>
            </div>
          )}
          {notice && (
            <p role="alert" className="inline-error mb-3">
              {notice}
            </p>
          )}
          <form onSubmit={handleSendMessage} className="chat-composer">
            <textarea
              ref={textareaRef}
              aria-label={`Mensaje para ${botTitle}`}
              value={inputPrompt}
              onChange={(e) => setInputPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              rows={1}
              placeholder={`Escribe a ${botTitle}…`}
              disabled={!bot || historyLoading}
            />
            <div className="composer-tools">
              <div className="composer-tools-left">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="icon-button"
                  aria-label="Adjuntar imagen"
                  title="Adjuntar imagen"
                >
                  <FiImage />
                </button>
                {voiceSupported && (
                  <button
                    type="button"
                    onClick={handleVoiceToggle}
                    className={`icon-button ${isListening ? "text-rose-300" : ""}`}
                    aria-label={
                      isListening ? "Detener dictado" : "Dictar mensaje"
                    }
                    title="Dictar mensaje"
                  >
                    {isListening ? <FiMicOff /> : <FiMic />}
                  </button>
                )}
                <span className="composer-shortcut">
                  Enter para enviar · Shift + Enter para otra línea
                </span>
              </div>
              {isStreaming ? (
                <button
                  type="button"
                  onClick={stopResponse}
                  className="send-button"
                  aria-label="Detener respuesta"
                >
                  <FiSquare />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label="Enviar mensaje"
                  disabled={
                    (!inputPrompt.trim() && !selectedImage) ||
                    !bot ||
                    historyLoading ||
                    selectedImage?.isUploading ||
                    Boolean(selectedImage?.error)
                  }
                >
                  <FiArrowUp />
                </button>
              )}
            </div>
          </form>
          <p className="composer-caption">
            Un poco de ayuda para tus grandes ideas. Revisa las respuestas
            importantes.
          </p>
        </div>
      </div>
    </div>
  );
}
