export class ResourceCache {
  private entries = new Map<
    string,
    {
      value?: unknown;
      hasValue: boolean;
      updated: number;
      generation: number;
      pending?: Promise<unknown>;
      error?: unknown;
      retryAt?: number;
    }
  >();
  private listeners = new Map<string, Set<(invalidated: boolean) => void>>();
  private limit: number;
  private clock: () => number;
  onCommit?: (key: string, value: unknown) => void;
  onInvalidate?: (key: string) => void;
  constructor(limit = 200, clock = Date.now) {
    this.limit = limit;
    this.clock = clock;
  }
  seed(key: string, value: unknown) {
    if (!this.entries.has(key))
      this.entries.set(key, {
        value,
        hasValue: true,
        updated: -Infinity,
        generation: 0,
      });
  }

  peek<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined;
  }
  subscribe(key: string, fn: (invalidated: boolean) => void) {
    const group = this.listeners.get(key) ?? new Set();
    group.add(fn);
    this.listeners.set(key, group);
    return () => {
      group.delete(fn);
      if (!group.size) this.listeners.delete(key);
    };
  }
  private emit(key: string, invalidated = false) {
    this.listeners.get(key)?.forEach((fn) => fn(invalidated));
  }
  invalidate(match: (key: string) => boolean = () => true, remove = false) {
    for (const [key, entry] of [...this.entries])
      if (match(key)) {
        this.onInvalidate?.(key);
        entry.generation++;
        entry.pending = undefined;
        entry.updated = -Infinity;
        entry.retryAt = 0;
        if (remove) {
          entry.value = undefined;
          entry.hasValue = false;
        }
        this.emit(key, !remove);
      }
  }
  read<T>(
    key: string,
    loader: () => Promise<T>,
    ttl = 60_000,
    force = false,
  ): Promise<T> {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { hasValue: false, updated: -Infinity, generation: 0 };
      this.entries.set(key, entry);
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.limit) {
      const candidate = [...this.entries].find(
        ([k, e]) => k !== key && !e.pending && !this.listeners.has(k),
      );
      if (!candidate) break;
      this.entries.delete(candidate[0]);
    }
    if (!force && entry.hasValue && this.clock() - entry.updated < ttl)
      return Promise.resolve(entry.value as T);
    if (!force && entry.retryAt && this.clock() < entry.retryAt)
      return Promise.reject(entry.error);
    if (entry.pending) return entry.pending as Promise<T>;
    const current = entry,
      generation = entry.generation;
    const pending = Promise.resolve()
      .then(loader)
      .then(
        (value) => {
          if (
            current.generation === generation &&
            this.entries.get(key) === current
          ) {
            current.value = value;
            current.hasValue = true;
            current.updated = this.clock();
            current.error = undefined;
            current.retryAt = 0;
            this.onCommit?.(key, value);
            this.emit(key);
          }
          if (current.generation !== generation)
            throw new DOMException("Resource invalidated", "AbortError");
          return value;
        },
        (error) => {
          if (current.generation === generation) {
            if (
              [403, 404].includes((error as { status?: number })?.status ?? 0)
            ) {
              current.value = undefined;
              current.hasValue = false;
              this.onInvalidate?.(key);
              this.emit(key);
            }
            current.error = error;
            current.retryAt = this.clock() + 10_000;
          }
          throw error;
        },
      )
      .finally(() => {
        if (current.pending === pending) current.pending = undefined;
      });
    entry.pending = pending;
    return pending;
  }
}
export const resources = new ResourceCache();
export function consumerSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
