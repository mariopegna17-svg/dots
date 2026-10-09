"use client";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import { FiAlertCircle } from "react-icons/fi";
import MascotAvatar, { botTone } from "./MascotAvatar";

function MessageItem({ message, bot, activity = "idle" }) {
  const user = message.sender === "user";
  const error =
    message.isError || message.text?.toLowerCase().startsWith("error:");
  const date = message.created_at ? new Date(message.created_at) : null;
  const time =
    date && !Number.isNaN(date.getTime())
      ? date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
      : "";
  if (error)
    return (
      <div className="message-row">
        <div className="message-error" role="alert">
          <FiAlertCircle />
          <span>{message.text}</span>
        </div>
      </div>
    );
  if (user)
    return (
      <div className="message-row user">
        <div className="message-bubble-user">
          {message.image_url && (
            <img
              src={message.image_url}
              alt="Imagen adjunta"
              className="message-image"
            />
          )}
          <div className="message-text">{message.text}</div>
          {time && <time>{time}</time>}
        </div>
      </div>
    );
  return (
    <div className="message-row">
      <MascotAvatar type={botTone(bot)} size="sm" activity={activity} />
      <div className="message-content">
        <div className="message-author">
          <span>{bot?.name || "Dot"}</span>
          {time && <time>{time}</time>}
        </div>
        <div className="message-text">
          <ReactMarkdown
            components={{
              a: ({ node, ...props }) => (
                <a {...props} target="_blank" rel="noopener noreferrer" />
              ),
            }}
          >
            {message.text || ""}
          </ReactMarkdown>
          {!message.text && (
            <div className="typing-indicator" aria-label="Preparando respuesta">
              <span />
              <span />
              <span />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(MessageItem);
