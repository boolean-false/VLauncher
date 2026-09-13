import type { ResourceCache } from "./resourceCache";
const STORAGE = "vlauncher.public-metadata.v1";
const LIMIT = 1024 * 1024;
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function connectPublicMetadata(cache: ResourceCache, registry: string) {
  let records: { key: string; value: unknown; at: number }[] = [];
  const allowed = (key: string) => {
    try {
      const [url, token, path] = JSON.parse(key);
      return (
        url === registry &&
        !token &&
        (/^\/projects(?:\?|\/[^/]+$)/.test(path) ||
          path.startsWith("/categories?"))
      );
    } catch {
      return false;
    }
  };
  const validValue = (key: string, value: unknown) => {
    const path = JSON.parse(key)[2];
    if (path.startsWith("/categories?"))
      return (
        Array.isArray(value) &&
        value.every(
          (v) => v && typeof v.id === "string" && typeof v.name === "string",
        )
      );
    if (!value || typeof value !== "object") return false;
    const data = value as Record<string, unknown>;
    const project = (v: unknown) =>
      !!v &&
      typeof v === "object" &&
      ["slug", "title", "type", "summary"].every(
        (field) => typeof (v as Record<string, unknown>)[field] === "string",
      );
    if (path.startsWith("/projects?"))
      return (
        Array.isArray(data.items) &&
        data.items.every(project) &&
        typeof data.total === "number"
      );
    return project(data) && typeof data.description === "string";
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
    if (Array.isArray(saved))
      records = saved
        .filter(
          (r) =>
            typeof r.key === "string" &&
            allowed(r.key) &&
            validValue(r.key, r.value) &&
            typeof r.at === "number" &&
            Date.now() - r.at < 24 * 60 * 60 * 1000,
        )
        .slice(-50);
    for (const record of records) cache.seed(record.key, record.value);
  } catch {
    records = [];
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE, JSON.stringify(records));
      } catch {
        /* Без localStorage запрос всё равно должен работать. */
      }
    }, 100);
  };
  cache.onCommit = (key, value) => {
    if (!allowed(key)) return;
    const item = { key, value, at: Date.now() };
    if (bytes(item) > 128 * 1024) return;
    records = records.filter((r) => r.key !== key);
    records.push(item);
    while (records.length > 50 || bytes(records) > LIMIT) records.shift();
    save();
  };
  cache.onInvalidate = (key) => {
    if (allowed(key)) {
      records = records.filter((r) => r.key !== key);
      save();
    }
  };
}
