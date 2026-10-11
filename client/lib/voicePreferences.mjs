const STORAGE_KEY = "dots-voice-preferences-v1";
export const DEFAULT_VOICE_PREFERENCES = Object.freeze({ voiceURI: "", rate: 1.05, pauseMs: 850 });

export function normalizeVoicePreferences(value = {}) {
  const rate = Number(value.rate);
  const pauseMs = Number(value.pauseMs);
  return {
    voiceURI: typeof value.voiceURI === "string" ? value.voiceURI.slice(0, 300) : "",
    rate: Number.isFinite(rate) && rate >= 0.75 && rate <= 1.4 ? rate : DEFAULT_VOICE_PREFERENCES.rate,
    pauseMs: [550, 850, 1200].includes(pauseMs) ? pauseMs : DEFAULT_VOICE_PREFERENCES.pauseMs,
  };
}

export function loadVoicePreferences(storage) {
  try { return normalizeVoicePreferences(JSON.parse(storage?.getItem(STORAGE_KEY) || "{}")); }
  catch { return { ...DEFAULT_VOICE_PREFERENCES }; }
}

export function saveVoicePreferences(storage, preferences) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(normalizeVoicePreferences(preferences))); } catch {}
}

// Consume only stable sentences. An incomplete link, code block or decimal must not be read early.
// Cursors refer to raw server text so removing Markdown cannot duplicate or skip streamed words.
export function takeSpeechSegments(raw, cursor = 0, final = false) {
  const text = String(raw || "");
  const segments = [];
  let start = cursor;
  let fence = false;
  let parentheses = 0;
  let brackets = 0;
  for (let i = cursor; i < text.length; i += 1) {
    if (text.slice(i, i + 3) === "```") { fence = !fence; i += 2; continue; }
    if (fence) continue;
    const char = text[i];
    if (char === "[") brackets += 1;
    if (char === "]") brackets = Math.max(0, brackets - 1);
    if (char === "(") parentheses += 1;
    if (char === ")") parentheses = Math.max(0, parentheses - 1);
    if (parentheses || brackets) continue;
    const punctuation = /[.!?…]/.test(char) && /\s/.test(text[i + 1] || "") && !(/\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || ""));
    const paragraph = char === "\n" && text[i + 1] === "\n";
    if (punctuation || paragraph) {
      segments.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (final && start < text.length) { segments.push(text.slice(start)); start = text.length; }
  return { segments, cursor: start };
}
