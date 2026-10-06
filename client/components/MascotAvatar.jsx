"use client";
import { FiAlertCircle } from "react-icons/fi";
import { useId } from "react";

export const DOT_CHARACTERS = [
  {
    id: "blue",
    label: "Azul con boina",
    color: "#518fff",
    crop: [59, 48, 650, 547],
  },
  {
    id: "lime",
    label: "Verde con ojos elevados",
    color: "#b6ed64",
    crop: [770, 148, 597, 444],
  },
  {
    id: "yellow",
    label: "Amarillo con gafas",
    color: "#ffd864",
    crop: [84, 600, 611, 443],
  },
  {
    id: "pink",
    label: "Rosa con gafas oscuras",
    color: "#f66ed2",
    crop: [746, 643, 659, 396],
  },
];

const legacyCharacters = {
  blue: "blue",
  "#3b82f6": "blue",
  lime: "lime",
  green: "lime",
  mint: "lime",
  emerald: "lime",
  "#10b981": "lime",
  yellow: "yellow",
  orange: "yellow",
  "#d97757": "yellow",
  pink: "pink",
  lavender: "pink",
  purple: "pink",
  "#a855f7": "pink",
};

export function botTone(bot) {
  return legacyCharacters[bot?.accent_color?.toLowerCase()] || "blue";
}
export default function MascotAvatar({
  type = "blue",
  size = "md",
  className = "",
  activity = "idle",
}) {
  const clipId = `dot-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const warning = ["warning", "alert"].includes(type);
  const character = DOT_CHARACTERS.find(
    ({ id }) => id === (legacyCharacters[type] || "blue"),
  );
  const [x, y, width, height] = character.crop;
  return (
    <span
      className={`dot-mascot mascot-${size} ${warning ? "mascot-warning" : "mascot-plush"} ${className}`}
      aria-hidden="true"
      data-character={warning ? "warning" : character.id}
      data-activity={warning ? undefined : activity}
    >
      {warning ? (
        <FiAlertCircle />
      ) : (
        <svg
          viewBox={character.crop.join(" ")}
          preserveAspectRatio="xMidYMid meet"
          fill="none"
        >
          <defs>
            <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
              <rect x={x} y={y} width={width} height={height} />
            </clipPath>
          </defs>
          <image
            href="/characters/dots-plush-atlas.png"
            width="1443"
            height="1090"
            clipPath={`url(#${clipId})`}
          />
        </svg>
      )}
    </span>
  );
}
