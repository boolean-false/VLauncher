import { getVersion } from "@tauri-apps/api/app";
import { registryUrl } from "./api";
const consentKey = "vlauncher.analytics.enabled";
const installationKey = "vlauncher.analytics.installation";
let enabled = readConsent();
let generation = 0;
let controller = new AbortController();
let version = "unknown";
let lastActiveDay = "";
let started = false;
export function hasAnalyticsChoice() {
  try {
    return ["true", "false"].includes(localStorage.getItem(consentKey) ?? "");
  } catch {
    return false;
  }
}
export function readConsent() {
  try {
    return localStorage.getItem(consentKey) === "true";
  } catch {
    return false;
  }
}
function installation() {
  try {
    const current = localStorage.getItem(installationKey);
    if (current) return current;
    const id = crypto.randomUUID();
    localStorage.setItem(installationKey, id);
    return id;
  } catch {
    return null;
  }
}
function os() {
  const p = navigator.userAgent.toLowerCase();
  return p.includes("windows")
    ? "windows"
    : p.includes("mac")
      ? "macos"
      : p.includes("linux")
        ? "linux"
        : "unknown";
}
async function send(path: string, body: unknown) {
  if (!enabled) return;
  const current = generation;
  const serialized = JSON.stringify(body);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!enabled || generation !== current) return;
    try {
      const response = await fetch(`${registryUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serialized,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        credentials: "omit",
      });
      if (response.ok || response.status < 500) return;
    } catch {
      /* Ошибка статистики не должна мешать приложению. */
    }
  }
}
export function recordActivity(kind: "app_start" | "active" | "game_start") {
  if (!enabled) return;
  const id = installation();
  if (!id) return;
  void send("/analytics/launcher", {
    event_id: crypto.randomUUID(),
    installation_id: id,
    kind,
    os: os(),
    version,
  });
}
function activeDay() {
  if (!enabled) return;
  const day = new Date().toISOString().slice(0, 10);
  if (day !== lastActiveDay) {
    lastActiveDay = day;
    recordActivity("active");
  }
}
export function setAnalyticsConsent(value: boolean) {
  localStorage.setItem(consentKey, String(value));
  enabled = value;
  generation++;
  controller.abort();
  controller = new AbortController();
  if (!value) {
    localStorage.removeItem(installationKey);
    lastActiveDay = "";
  } else activeDay();
  window.dispatchEvent(new Event("analytics-consent-changed"));
}
export function recordContent(
  slug: string,
  kind: "view" | "install",
  releaseVersion = "",
) {
  if (!enabled) return;
  void send(`/analytics/projects/${encodeURIComponent(slug)}`, {
    event_id: crypto.randomUUID(),
    kind,
    source: "launcher",
    version: releaseVersion,
    os: os(),
  });
}
export function startAnalytics() {
  if (started) return () => {};
  started = true;
  void getVersion()
    .then((v) => {
      version = v;
      if (enabled) {
        recordActivity("app_start");
        lastActiveDay = new Date().toISOString().slice(0, 10);
      }
    })
    .catch(() => {});
  const timer = window.setInterval(activeDay, 60_000);
  const changed = () => {
    if (!document.hidden) activeDay();
  };
  window.addEventListener("focus", changed);
  document.addEventListener("visibilitychange", changed);
  return () => {
    started = false;
    clearInterval(timer);
    controller.abort();
    window.removeEventListener("focus", changed);
    document.removeEventListener("visibilitychange", changed);
  };
}
