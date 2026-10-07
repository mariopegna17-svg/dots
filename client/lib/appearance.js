export const DEFAULT_APPEARANCE = { theme: 'dark', theme_accent: 'blue', theme_density: 'comfortable', theme_motion: 'full' };
const VALUES = { theme: ['dark', 'light', 'aurora', 'midnight'], theme_accent: ['blue', 'mint', 'violet', 'rose'], theme_density: ['comfortable', 'compact'], theme_motion: ['full', 'reduced'] };
export function normalizeAppearance(data = {}) {
  return Object.fromEntries(Object.entries(VALUES).map(([key, values]) => [key, values.includes(data[key]) ? data[key] : DEFAULT_APPEARANCE[key]]));
}
export function savedAppearance() {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE;
  try { return normalizeAppearance(JSON.parse(localStorage.getItem('dots_appearance') || '{}')); } catch { return DEFAULT_APPEARANCE; }
}
export function applyAppearance(data, persist = false) {
  if (typeof document === 'undefined') return;
  const appearance = normalizeAppearance(data);
  const root = document.documentElement;
  root.dataset.theme = appearance.theme;
  root.dataset.accent = appearance.theme_accent;
  root.dataset.density = appearance.theme_density;
  root.dataset.motion = appearance.theme_motion;
  root.style.colorScheme = appearance.theme === 'light' ? 'light' : 'dark';
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => { meta.content = appearance.theme === 'light' ? '#f1f5fc' : appearance.theme === 'midnight' ? '#07090f' : appearance.theme === 'aurora' ? '#141326' : '#0e1420'; });
  if (persist) { try { localStorage.setItem('dots_appearance', JSON.stringify(appearance)); } catch { /* Appearance still works if storage is unavailable. */ } }
  window.dispatchEvent(new CustomEvent('dots:appearance', { detail: appearance }));
}
