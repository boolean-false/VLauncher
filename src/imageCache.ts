const MAX_BYTES = 32 * 1024 * 1024;
type Entry = { url: string; bytes: number; refs: number; used: number };
const images = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();
const generations = new Map<string, number>();
const keyFor = (src: string, token: string) => JSON.stringify([src, token]);
function trim() {
  let bytes = [...images.values()].reduce((sum, e) => sum + e.bytes, 0);
  for (const [key, entry] of [...images].sort(
    (a, b) => a[1].used - b[1].used,
  )) {
    if (bytes <= MAX_BYTES && images.size <= 100) break;
    if (entry.refs) continue;
    images.delete(key);
    URL.revokeObjectURL(entry.url);
    bytes -= entry.bytes;
  }
}
export const peekImage = (src: string, token: string) =>
  images.get(keyFor(src, token))?.url ?? "";
export async function acquireImage(src: string, token: string) {
  const key = keyFor(src, token);
  let entry = images.get(key);
  if (!entry) {
    let request = pending.get(key);
    if (!request) {
      const generation = generations.get(token) ?? 0;
      request = fetch(src, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        signal: AbortSignal.timeout(20_000),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Изображение недоступно");
          const blob = await response.blob();
          if (blob.size > 8 * 1024 * 1024)
            throw new Error("Изображение слишком большое");
          if ((generations.get(token) ?? 0) !== generation)
            throw new Error("Сессия завершена");
          const item = {
            url: URL.createObjectURL(blob),
            bytes: blob.size,
            refs: 0,
            used: Date.now(),
          };
          images.set(key, item);
          return item;
        })
        .finally(() => {
          if (pending.get(key) === request) pending.delete(key);
        });
      pending.set(key, request);
    }
    entry = await request;
  }
  entry.refs++;
  entry.used = Date.now();
  trim();
  const current = entry;
  return {
    url: entry.url,
    release: () => {
      current.refs = Math.max(0, current.refs - 1);
      trim();
    },
  };
}
export function clearImageSession(token: string) {
  generations.set(token, (generations.get(token) ?? 0) + 1);
  for (const [key, entry] of images)
    if (JSON.parse(key)[1] === token) {
      images.delete(key);
      URL.revokeObjectURL(entry.url);
    }
  for (const key of pending.keys())
    if (JSON.parse(key)[1] === token) pending.delete(key);
  window.dispatchEvent(
    new CustomEvent("image-session-cleared", { detail: token }),
  );
}
