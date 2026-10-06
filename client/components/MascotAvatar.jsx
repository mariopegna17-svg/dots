"use client";
import { useId } from "react";
const palettes = {
  lime: ["#9dd97a", "#68a653"],
  blue: ["#8db9f8", "#4d80ca"],
  pink: ["#ec9abd", "#cb6e97"],
  orange: ["#edb886", "#c88655"],
  mint: ["#96d6c0", "#62aa94"],
  lavender: ["#b9a3e2", "#8d76bc"],
};
export function botTone(bot) {
  if (bot?.id === "bot-open-dots-1") return "lime";
  const color = bot?.accent_color;
  if (["#d97757", "orange"].includes(color)) return "orange";
  if (["#10b981", "mint", "emerald"].includes(color)) return "mint";
  if (["#a855f7", "lavender", "purple"].includes(color)) return "lavender";
  return palettes[color] ? color : "blue";
}
export default function MascotAvatar({
  type = "blue",
  size = "md",
  className = "",
}) {
  const id = useId().replace(/:/g, "");
  const colors = palettes[type] || palettes.blue;
  const warning = ["warning", "alert"].includes(type);
  return (
    <span
      className={`dot-mascot mascot-${size} ${className}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" fill="none">
        <defs>
          <linearGradient
            id={`${id}-color`}
            x1="24"
            y1="22"
            x2="72"
            y2="90"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor={colors[0]} />
            <stop offset="1" stopColor={colors[1]} />
          </linearGradient>
        </defs>
        <path
          d="M40 18Q50 5 60 18L86 66Q95 86 74 87H26Q5 86 14 66Z"
          fill={`url(#${id}-color)`}
        />
        {warning ? (
          <path
            d="M50 42v15m0 11v1"
            stroke="#242424"
            strokeWidth="5"
            strokeLinecap="round"
          />
        ) : (
          <>
            <ellipse cx="39" cy="53" rx="7" ry="8" fill="#fff" />
            <ellipse cx="62" cy="53" rx="7" ry="8" fill="#fff" />
            <ellipse cx="40" cy="54" rx="3" ry="4" fill="#242424" />
            <ellipse cx="63" cy="54" rx="3" ry="4" fill="#242424" />
          </>
        )}
      </svg>
    </span>
  );
}
