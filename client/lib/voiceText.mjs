export const VOICE_GREETING = "Hola, soy tu Dot. Ya puedes hablar conmigo.";

export function voiceText(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, " He dejado el código en el chat. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "el enlace del chat")
    .replace(/(^|\n)\s{0,3}[#>*-]+\s*/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function speechChunks(text, maxLength = 220) {
  const clean = voiceText(text);
  let remaining = clean.length > 6000
    ? `${clean.slice(0, 6000)}. Puedes leer el resto en el chat.`
    : clean;
  const chunks = [];
  while (remaining) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    const prefix = remaining.slice(0, maxLength);
    const sentence = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("? "), prefix.lastIndexOf("! "));
    const space = prefix.lastIndexOf(" ");
    const cut = sentence > maxLength / 3 ? sentence + 1 : space > 0 ? space : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}
