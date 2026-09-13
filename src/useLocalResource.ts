import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { resources } from "./resourceCache";
export const invalidateLocalResources = () =>
  resources.invalidate((key) => key.startsWith("local:"));
export function useLocalResource<T>(
  command: string,
  args: Record<string, unknown> = {},
  ttl = 30_000,
  enabled = true,
) {
  const key = "local:" + JSON.stringify([command, args]);
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error: string;
    loading: boolean;
  }>(() => ({ key, data: resources.peek<T>(key), error: "", loading: true }));
  const handledRefresh = useRef(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true,
      sequence = 0;
    const read = (force = false) => {
      const seq = ++sequence;
      setState({
        key,
        data: resources.peek<T>(key),
        error: "",
        loading: resources.peek(key) === undefined,
      });
      const [, params] = JSON.parse(key.slice(6));
      void resources
        .read<T>(key, () => invoke<T>(command, params), ttl, force)
        .then((data) => {
          if (alive && seq === sequence)
            setState({ key, data, error: "", loading: false });
        })
        .catch((e) => {
          if (alive && seq === sequence)
            setState({
              key,
              data: resources.peek<T>(key),
              error: String(e),
              loading: false,
            });
        });
    };
    const unsub = resources.subscribe(key, (invalidated) => {
      if (invalidated) read();
    });
    read(revision !== handledRefresh.current);
    handledRefresh.current = revision;
    const focus = () => read();
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      unsub();
      window.removeEventListener("focus", focus);
    };
  }, [key, command, ttl, revision, enabled]);
  const refresh = useCallback(() => setRevision((n) => n + 1), []);
  return {
    ...(state.key === key
      ? state
      : { data: resources.peek<T>(key), error: "", loading: true }),
    refresh,
  };
}
