import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  applyTheme, contrastRatio, defaultTheme, loadActiveTheme, loadSavedThemes, normalizeColor,
  saveThemeLibrary, setActiveTheme, themePresets, validateTheme,
  type ThemeConfig, type ThemeTokenName,
} from "../design-system/theme";
import { Icon } from "./ui";

const labels: Record<ThemeTokenName, string> = {
  bg: "Фон", "surface-inset": "Углублённая поверхность", panel: "Панель",
  "surface-2": "Интерактивная поверхность", line: "Границы", text: "Основной текст",
  muted: "Вторичный текст", accent: "Главное действие", "accent-text": "Акцентный текст",
  "accent-bg": "Акцентное выделение", "accent-hover": "Наведение", "on-accent": "Текст на кнопке",
  "focus-ring": "Фокус", warning: "Предупреждение", "warning-bg": "Фон предупреждения",
  "warning-line": "Граница предупреждения", danger: "Ошибка", "danger-bg": "Фон ошибки",
  "danger-line": "Граница ошибки", success: "Успех", "success-bg": "Фон успеха",
  "success-line": "Граница успеха", overlay: "Затемнение модалки",
};

const groups: { title: string; tokens: ThemeTokenName[] }[] = [
  { title: "Поверхности и текст", tokens: ["bg", "surface-inset", "panel", "surface-2", "line", "text", "muted"] },
  { title: "Акцент и управление", tokens: ["accent", "accent-text", "accent-bg", "accent-hover", "on-accent", "focus-ring"] },
  { title: "Состояния", tokens: ["warning", "warning-bg", "warning-line", "danger", "danger-bg", "danger-line", "success", "success-bg", "success-line"] },
  { title: "Системное", tokens: ["overlay"] },
];

const clone = (theme: ThemeConfig): ThemeConfig => structuredClone(theme);

export function ThemeSettings() {
  const [active, setActive] = useState(loadActiveTheme);
  const [draft, setDraft] = useState(loadActiveTheme);
  const [saved, setSaved] = useState(loadSavedThemes);
  const [message, setMessage] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const activeRef = useRef(active);
  useEffect(() => () => applyTheme(activeRef.current), []);
  const draftError = useMemo(() => {
    try { validateTheme(draft); return ""; } catch (error) { return String(error instanceof Error ? error.message : error); }
  }, [draft]);
  const warnings = useMemo(() => {
    const pairs: [string, string, string][] = [
      ["Основной текст", draft.tokens.text, draft.tokens.bg],
      ["Вторичный текст", draft.tokens.muted, draft.tokens.panel],
      ["Текст главной кнопки", draft.tokens["on-accent"], draft.tokens.accent],
      ["Акцентная подпись", draft.tokens["accent-text"], draft.tokens["accent-bg"]],
    ];
    return pairs.filter(([, first, second]) => contrastRatio(first, second) < 4.5).map(([name]) => name);
  }, [draft]);

  const update = (next: ThemeConfig) => {
    setDraft(next);
    applyTheme(next);
    setMessage("");
  };
  const activate = (theme: ThemeConfig) => {
    const next = clone(theme);
    activeRef.current = next; setActive(next); setDraft(next); setActiveTheme(next);
    setMessage(`Тема «${next.name}» применена.`);
  };
  const importConfig = (text: string) => {
    const imported = validateTheme(JSON.parse(text));
    imported.id = `custom-${crypto.randomUUID()}`;
    activate(imported);
    const next = [imported, ...saved.filter((item) => item.name !== imported.name)];
    setSaved(next); saveThemeLibrary(next);
  };
  const downloadConfig = (config: string) => {
    const url = URL.createObjectURL(new Blob([config], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `${draft.name}.vlauncher-theme.json`; link.click();
    URL.revokeObjectURL(url);
  };
  const exportConfig = async () => {
    const config = JSON.stringify(validateTheme(draft), null, 2);
    if (!("__TAURI_INTERNALS__" in window)) {
      downloadConfig(config); setMessage("Конфигурация темы экспортирована."); return;
    }
    try {
      const path = await save({ defaultPath: `${draft.name.replace(/[^a-zа-я0-9_-]+/gi, "-")}.vlauncher-theme.json`, filters: [{ name: "Тема VLauncher", extensions: ["json"] }] });
      if (!path) return;
      await invoke("write_theme_config", { path, contents: config });
      setMessage("Конфигурация темы экспортирована.");
    } catch (error) { setMessage(`Не удалось экспортировать тему: ${String(error)}`); }
  };
  const importFromFile = async () => {
    if (!("__TAURI_INTERNALS__" in window)) { importInput.current?.click(); return; }
    try {
      const path = await open({ multiple: false, filters: [{ name: "Тема VLauncher", extensions: ["json"] }] });
      if (typeof path === "string") importConfig(await invoke<string>("read_theme_config", { path }));
    } catch (error) { setMessage(`Не удалось импортировать тему: ${String(error)}`); }
  };

  return (
    <section className="theme-settings" aria-labelledby="theme-settings-title">
      <div className="section-heading theme-heading">
        <div><h2 id="theme-settings-title">Оформление</h2><p>Пресеты, собственные темы.</p></div>
        <div className="actions"><button onClick={() => void importFromFile()}>Импортировать…</button><button onClick={() => void exportConfig()}>Экспортировать…</button></div>
        <input ref={importInput} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => {
          const file = event.target.files?.[0]; if (!file) return;
          void file.text().then(importConfig).catch((error) => setMessage(String(error))); event.target.value = "";
        }} />
      </div>

      <div className="theme-preset-grid">
        {themePresets.map((theme) => <button key={theme.id} className={`theme-preset ${active.id === theme.id ? "active" : ""}`} onClick={() => activate(theme)}>
          <span className="theme-swatches" aria-hidden="true">{["bg", "panel", "surface-2", "accent"].map((token) => <i key={token} style={{ background: theme.tokens[token as ThemeTokenName] }} />)}</span>
          <strong>{theme.name}</strong><small>{theme.id === "cga" ? "Только 16 цветов CGA" : theme.id === "ink-paper" ? "Основная тема" : "Пресет"}</small>
        </button>)}
      </div>

      {!!saved.length && <div className="saved-themes"><h3>Сохранённые темы</h3>{saved.map((theme) => <div key={theme.id}>
        <button className="text-button grow" onClick={() => activate(theme)}>{theme.name}</button>
        <button className="icon-button" aria-label={`Удалить тему ${theme.name}`} onClick={() => { const next = saved.filter((item) => item.id !== theme.id); setSaved(next); saveThemeLibrary(next); }}><Icon name="close" size={14} /></button>
      </div>)}</div>}

      <div className="theme-editor-heading">
        <label>Название темы<input value={draft.name} maxLength={80} onChange={(event) => update({ ...draft, id: draft.id.startsWith("custom-") ? draft.id : `custom-${crypto.randomUUID()}`, name: event.target.value })} /></label>
        <label>Радиус · {draft.radius}px<input type="range" min="0" max="24" step="1" value={draft.radius} onChange={(event) => update({ ...draft, id: `custom-${crypto.randomUUID()}`, radius: Number(event.target.value) })} /></label>
      </div>

      <div className="theme-token-groups">
        {groups.map((group) => <fieldset key={group.title}><legend>{group.title}</legend><div className="theme-token-grid">
          {group.tokens.map((token) => <label className="theme-token" key={token}><span>{labels[token]}</span><span className="theme-color-control">
            <input aria-label={`${labels[token]} - палитра`} type="color" value={draft.tokens[token].slice(0, 7)} onChange={(event) => update({ ...draft, id: `custom-${crypto.randomUUID()}`, tokens: { ...draft.tokens, [token]: event.target.value } })} />
            <input aria-label={`${labels[token]} - код`} className="selectable" value={draft.tokens[token]} placeholder="#RRGGBB или rgb(…)" onChange={(event) => {
              const value = event.target.value; setDraft({ ...draft, id: `custom-${crypto.randomUUID()}`, tokens: { ...draft.tokens, [token]: value } });
              const normalized = normalizeColor(value);
              if (normalized) applyTheme({ ...draft, tokens: { ...draft.tokens, [token]: normalized } });
            }} onBlur={(event) => {
              const normalized = normalizeColor(event.target.value);
              if (normalized) setDraft((current) => ({ ...current, tokens: { ...current.tokens, [token]: normalized } }));
            }} />
          </span></label>)}
        </div></fieldset>)}
      </div>

      {draftError && <div className="theme-contrast-warning" role="alert">{draftError}</div>}
      {!draftError && warnings.length > 0 && <div className="theme-contrast-warning" role="status">Низкий контраст: {warnings.join(", ")}. Тему можно сохранить, но текст может читаться хуже.</div>}
      {message && <p className="theme-message" aria-live="polite">{message}</p>}
      <div className="theme-actions">
        <button className="primary" disabled={!!draftError} onClick={() => activate(draft)}>Применить</button>
        <button disabled={!!draftError} onClick={() => {
          const item = validateTheme({ ...draft, id: `custom-${crypto.randomUUID()}`, name: draft.name.trim() || "Моя тема" });
          const next = [item, ...saved]; setSaved(next); saveThemeLibrary(next); activate(item);
        }}>Сохранить как свою</button>
        <button onClick={() => update(clone(active))}>Отменить изменения</button>
        <button className="text-button" onClick={() => activate(defaultTheme)}>Вернуть основную тему</button>
      </div>
    </section>
  );
}
