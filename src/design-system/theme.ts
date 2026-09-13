export const themeTokenNames = [
  "bg", "surface-inset", "panel", "surface-2", "line", "text", "muted",
  "accent", "accent-text", "accent-bg", "accent-hover", "on-accent", "focus-ring",
  "warning", "warning-bg", "warning-line", "danger", "danger-bg", "danger-line",
  "success", "success-bg", "success-line", "overlay",
] as const;

export type ThemeTokenName = (typeof themeTokenNames)[number];
export type ThemeTokens = Record<ThemeTokenName, string>;
export type ThemeConfig = {
  format: "vlauncher-theme";
  version: 1;
  id: string;
  name: string;
  tokens: ThemeTokens;
  radius: number;
};

const cga = {
  black: "#000000", navy: "#0000aa", green: "#00aa00", cyan: "#00aaaa",
  red: "#aa0000", magenta: "#aa00aa", brown: "#aa5500", silver: "#aaaaaa",
  gray: "#555555", blue: "#5555ff", lime: "#55ff55", aqua: "#55ffff",
  coral: "#ff5555", pink: "#ff55ff", yellow: "#ffff55", white: "#ffffff",
} as const;

const preset = (id: string, name: string, tokens: ThemeTokens, radius = 0): ThemeConfig => ({
  format: "vlauncher-theme", version: 1, id, name, tokens, radius,
});

export const themePresets: ThemeConfig[] = [
  preset("ink-paper", "Стандартная", {
    bg: "#171b20", "surface-inset": "#12161a", panel: "#1e242b", "surface-2": "#272f37",
    line: "#35414c", text: "#e8e7e0", muted: "#aab2bc", accent: "#dad9ca",
    "accent-text": "#dad9ca", "accent-bg": "#30332f", "accent-hover": "#ecebdf",
    "on-accent": "#23251f", "focus-ring": "#dad9ca", warning: "#dbc08e",
    "warning-bg": "#302a20", "warning-line": "#6d5938", danger: "#e7a5a1",
    "danger-bg": "#342523", "danger-line": "#754b46", success: "#b9cd95",
    "success-bg": "#283022", "success-line": "#526340", overlay: "#090d0bb8",
  }),
  preset("jetbrains-linen", "JetBrains", {
    bg: "#1e1f22", "surface-inset": "#242528", panel: "#2b2d30", "surface-2": "#393b40",
    line: "#43454a", text: "#dfe1e5", muted: "#9da0a8", accent: "#d4c49d",
    "accent-text": "#d4c49d", "accent-bg": "#36332d", "accent-hover": "#e6d9b9",
    "on-accent": "#272319", "focus-ring": "#d4c49d", warning: "#f2c55c",
    "warning-bg": "#3d3223", "warning-line": "#5e4d33", danger: "#e37774",
    "danger-bg": "#402929", "danger-line": "#7a4343", success: "#73bd79",
    "success-bg": "#253627", "success-line": "#436946", overlay: "#090e12b8",
  }),
  preset("cga", "CGA", {
    bg: cga.black, "surface-inset": cga.navy, panel: cga.gray, "surface-2": cga.navy,
    line: cga.silver, text: cga.white, muted: cga.silver, accent: cga.aqua,
    "accent-text": cga.aqua, "accent-bg": cga.navy, "accent-hover": cga.white,
    "on-accent": cga.black, "focus-ring": cga.aqua, warning: cga.yellow,
    "warning-bg": cga.brown, "warning-line": cga.yellow, danger: cga.coral,
    "danger-bg": cga.red, "danger-line": cga.coral, success: cga.lime,
    "success-bg": cga.green, "success-line": cga.lime, overlay: cga.black,
  }),
  preset("polar-night", "Синяя", {
    bg: "#101820", "surface-inset": "#0b1117", panel: "#182630", "surface-2": "#223541",
    line: "#385262", text: "#e5eef0", muted: "#9fb3ba", accent: "#a8d5df",
    "accent-text": "#bfe5ec", "accent-bg": "#243942", "accent-hover": "#cae9ee",
    "on-accent": "#14272c", "focus-ring": "#a8d5df", warning: "#e1c184",
    "warning-bg": "#30291f", "warning-line": "#665538", danger: "#e6a29f",
    "danger-bg": "#342326", "danger-line": "#704449", success: "#a8cfb1",
    "success-bg": "#203329", "success-line": "#456b51", overlay: "#05090dcc",
  }),
  preset("violet-signal", "Фиолетовая", {
    bg: "#191821", "surface-inset": "#121119", panel: "#24222d", "surface-2": "#302d3a",
    line: "#494455", text: "#ece9ef", muted: "#b4adbb", accent: "#c7b3e6",
    "accent-text": "#d6c6ed", "accent-bg": "#3a3147", "accent-hover": "#dfd2f0",
    "on-accent": "#2a2134", "focus-ring": "#c7b3e6", warning: "#e2c17f",
    "warning-bg": "#322a20", "warning-line": "#69583a", danger: "#e7a2ad",
    "danger-bg": "#38252d", "danger-line": "#744655", success: "#acd0b1",
    "success-bg": "#23332a", "success-line": "#4b6851", overlay: "#08070dcc",
  }),
  preset("terminal-amber", "Янтарная", {
    bg: "#14130f", "surface-inset": "#0d0c09", panel: "#211f18", "surface-2": "#302d22",
    line: "#514a33", text: "#eee7d2", muted: "#b9ad8e", accent: "#e4bd63",
    "accent-text": "#efcd7d", "accent-bg": "#3d321c", "accent-hover": "#f2d48e",
    "on-accent": "#2c220f", "focus-ring": "#e4bd63", warning: "#ffd66d",
    "warning-bg": "#382b12", "warning-line": "#765a20", danger: "#e99a81",
    "danger-bg": "#38221b", "danger-line": "#784536", success: "#bace88",
    "success-bg": "#283019", "success-line": "#58683a", overlay: "#070601cc",
  }),
  preset("oxide", "Зелёная", {
    bg: "#181c1b", "surface-inset": "#111413", panel: "#222927", "surface-2": "#2d3734",
    line: "#43524e", text: "#e5ebe8", muted: "#a6b5b0", accent: "#a7cdc3",
    "accent-text": "#b9d9d1", "accent-bg": "#293b37", "accent-hover": "#cbe3dd",
    "on-accent": "#182824", "focus-ring": "#a7cdc3", warning: "#ddbf83",
    "warning-bg": "#30291e", "warning-line": "#68583a", danger: "#e5a19d",
    "danger-bg": "#352524", "danger-line": "#714845", success: "#afd0a4",
    "success-bg": "#263325", "success-line": "#4d6849", overlay: "#070a09c4",
  }),
  preset("high-contrast", "Контрастная", {
    bg: "#0b0c0e", "surface-inset": "#050608", panel: "#17191d", "surface-2": "#252931",
    line: "#616a78", text: "#ffffff", muted: "#c2c8d0", accent: "#ffe08a",
    "accent-text": "#ffe08a", "accent-bg": "#3d351e", "accent-hover": "#ffedb5",
    "on-accent": "#211b0b", "focus-ring": "#ffe08a", warning: "#ffd166",
    "warning-bg": "#33270e", "warning-line": "#9a7623", danger: "#ff9999",
    "danger-bg": "#3d1717", "danger-line": "#a34848", success: "#a8e59d",
    "success-bg": "#17351a", "success-line": "#4d914b", overlay: "#000000e0",
  }),
];

export const defaultTheme = themePresets[0];
const activeKey = "vlauncher.theme.active.v1";
const savedKey = "vlauncher.theme.saved.v1";
const colorPattern = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

export function normalizeColor(value: string) {
  const clean = value.trim().toLowerCase();
  if (colorPattern.test(clean)) return clean;
  const match = clean.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})(?:\s*[,/]\s*(0|1|0?\.\d+))?\s*\)$/);
  if (!match) return null;
  const channels = match.slice(1, 4).map(Number);
  if (channels.some((channel) => channel > 255)) return null;
  const hex = channels.map((channel) => channel.toString(16).padStart(2, "0")).join("");
  const alpha = match[4] === undefined ? "" : Math.round(Number(match[4]) * 255).toString(16).padStart(2, "0");
  return `#${hex}${alpha}`;
}

export function validateTheme(value: unknown): ThemeConfig {
  if (!value || typeof value !== "object") throw new Error("Файл не содержит тему VLauncher.");
  const source = value as Partial<ThemeConfig>;
  if (source.format !== "vlauncher-theme" || source.version !== 1)
    throw new Error("Неизвестный формат темы или версия файла.");
  if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 80)
    throw new Error("Название темы отсутствует или слишком длинное.");
  if (!source.tokens || typeof source.tokens !== "object") throw new Error("В теме нет цветовых токенов.");
  const tokens = {} as ThemeTokens;
  for (const name of themeTokenNames) {
    const color = source.tokens[name];
    const normalized = typeof color === "string" ? normalizeColor(color) : null;
    if (!normalized)
      throw new Error(`Некорректный цвет: ${name}. Используйте HEX или rgb(…).`);
    tokens[name] = normalized;
  }
  const radius = Number(source.radius);
  if (!Number.isFinite(radius) || radius < 0 || radius > 24) throw new Error("Радиус должен быть от 0 до 24 px.");
  return preset(typeof source.id === "string" ? source.id : crypto.randomUUID(), source.name.trim(), tokens, radius);
}

export function applyTheme(theme: ThemeConfig) {
  const root = document.documentElement;
  for (const name of themeTokenNames) root.style.setProperty(`--${name}`, theme.tokens[name]);
  root.style.setProperty("--radius", `${theme.radius}px`);
  root.dataset.theme = theme.id;
}

export function loadActiveTheme(): ThemeConfig {
  try {
    const raw = localStorage.getItem(activeKey);
    if (raw) return validateTheme(JSON.parse(raw));
  } catch { /* Fall back to the product default. */ }
  return structuredClone(defaultTheme);
}

export function setActiveTheme(theme: ThemeConfig) {
  const valid = validateTheme(theme);
  localStorage.setItem(activeKey, JSON.stringify(valid));
  applyTheme(valid);
  window.dispatchEvent(new CustomEvent("vlauncher-theme-change", { detail: valid }));
}

export function loadSavedThemes(): ThemeConfig[] {
  try {
    const value = JSON.parse(localStorage.getItem(savedKey) ?? "[]");
    return Array.isArray(value) ? value.flatMap((item) => { try { return [validateTheme(item)]; } catch { return []; } }) : [];
  } catch { return []; }
}

export function saveThemeLibrary(themes: ThemeConfig[]) {
  localStorage.setItem(savedKey, JSON.stringify(themes.slice(0, 50).map(validateTheme)));
}

export function contrastRatio(first: string, second: string) {
  const luminance = (color: string) => {
    const rgb = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
    return rgb.reduce((sum, value, index) => sum + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index], 0);
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1] + .05) / (values[0] + .05);
}
