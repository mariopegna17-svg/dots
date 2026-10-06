"use client";
import { useId } from "react";

const palettes = {
  lime: ["#ebffbe", "#a2d97b", "#385b32"],
  blue: ["#b9dfff", "#77a6e9", "#35468b"],
  pink: ["#ffd0e0", "#da8fba", "#773963"],
  orange: ["#ffe0b7", "#edab75", "#8d5137"],
  mint: ["#baffdf", "#70c8a3", "#2c665b"],
  lavender: ["#e4d7ff", "#a897dd", "#534777"],
};

export function botTone(bot) {
  if (bot?.id === "bot-open-dots-1") return "lime";
  const color = bot?.accent_color;
  if (color === "#d97757" || color === "orange") return "orange";
  if (color === "#10b981" || color === "mint" || color === "emerald")
    return "mint";
  if (color === "#a855f7" || color === "lavender" || color === "purple")
    return "lavender";
  return palettes[color] ? color : "blue";
}

export default function MascotAvatar({
  type = "lime",
  size = "md",
  className = "",
}) {
  const id = useId().replace(/:/g, "");
  const colors = palettes[type] || palettes.blue;
  const warning = type === "warning" || type === "alert";
  const shape =
    type === "orange"
      ? "M24 28Q20 18 33 19L52 20Q67 17 74 32L84 56Q91 74 72 78L39 83Q17 86 17 66Z"
      : type === "lavender" || type === "pink"
        ? "M29 25Q23 9 39 14L52 24Q76 14 79 35L77 63Q76 85 52 84L28 80Q12 75 17 56Z"
        : type === "mint"
          ? "M20 41Q20 20 43 20L62 20Q84 21 83 43L83 63Q81 84 60 84L40 84Q18 81 19 61Z"
          : "M17 51Q16 24 40 19Q64 11 81 35Q93 52 83 69Q75 87 49 85Q20 83 17 51Z";
  return (
    <span
      className={`dot-mascot mascot-${size} ${className}`}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 104" fill="none">
        <defs>
          <radialGradient
            id={`${id}-body`}
            cx="0"
            cy="0"
            r="1"
            gradientTransform="translate(35 25) rotate(53) scale(80 70)"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor={colors[0]} />
            <stop offset=".5" stopColor={colors[1]} />
            <stop offset="1" stopColor={colors[2]} />
          </radialGradient>
          <linearGradient
            id={`${id}-shine`}
            x1="30"
            y1="22"
            x2="68"
            y2="80"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="white" stopOpacity=".6" />
            <stop offset=".8" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <radialGradient id={`${id}-shadow`}>
            <stop stopColor={colors[2]} stopOpacity=".5" />
            <stop offset="1" stopColor={colors[2]} stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="51" cy="94" rx="34" ry="6" fill={`url(#${id}-shadow)`} />
        <path d={shape} fill={`url(#${id}-body)`} />
        <path d={shape} stroke={`url(#${id}-shine)`} strokeWidth="1.5" />
        <path
          d="M29 37Q32 29 41 27"
          stroke="white"
          strokeOpacity=".35"
          strokeWidth="4"
          strokeLinecap="round"
        />
        {warning ? (
          <>
            <path
              d="M50 41v18"
              stroke="#243025"
              strokeWidth="5"
              strokeLinecap="round"
            />
            <circle cx="50" cy="69" r="3" fill="#243025" />
          </>
        ) : (
          <>
            <ellipse cx="40" cy="51" rx="7" ry="9" fill="#f7ffec" />
            <ellipse cx="63" cy="51" rx="7" ry="9" fill="#f7ffec" />
            <ellipse cx="42" cy="53" rx="3.4" ry="5" fill="#243025" />
            <ellipse cx="65" cy="53" rx="3.4" ry="5" fill="#243025" />
            <circle cx="43" cy="51" r="1.2" fill="white" />
            <circle cx="66" cy="51" r="1.2" fill="white" />
            <path
              d="M48 66q4 3 8-1"
              stroke="#243025"
              strokeOpacity=".7"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
          </>
        )}
      </svg>
    </span>
  );
}
