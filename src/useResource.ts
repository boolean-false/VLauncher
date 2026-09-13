import { useCallback, useEffect, useRef, useState } from "react";
import { registryKey, registryRequest } from "./api";
import { resources } from "./resourceCache";

export function useRegistryResource<T>(
  path: string,
  token?: string,
  enabled = true,
) {
  const key = registryKey(path, token);
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error: string;
    fetching: boolean;
  }>(() => ({
    key,
    data: resources.peek<T>(key),
    error: "",
    fetching: enabled,
  }));
  const handledRefresh = useRef(0);
  const [retry, setRetry] = useState(0);
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
        fetching: true,
      });
      void registryRequest<T>(
        path,
        force ? { cache: "reload" } : undefined,
        token,
      )
        .then((data) => {
          if (alive && seq === sequence)
            setState({ key, data, error: "", fetching: false });
        })
        .catch((e) => {
          if (alive && seq === sequence)
            setState({
              key,
              data: resources.peek<T>(key),
              error: String(e),
              fetching: false,
            });
        });
    };
    const unsubscribe = resources.subscribe(key, (invalidated) => {
      if (invalidated) read();
      else if (alive)
        setState({
          key,
          data: resources.peek<T>(key),
          error: "",
          fetching: false,
        });
    });
    read(retry !== handledRefresh.current);
    handledRefresh.current = retry;
    // При возврате на экран проверяем, не устарели ли данные.
    const focus = () => {
      if (document.visibilityState === "visible") read();
    };
    window.addEventListener("focus", focus);
    return () => {
      alive = false;
      unsubscribe();
      window.removeEventListener("focus", focus);
    };
  }, [key, path, token, enabled, retry]);
  const refresh = useCallback(() => setRetry((n) => n + 1), []);
  const current =
    state.key === key
      ? state
      : { data: resources.peek<T>(key), error: "", fetching: true };
  return {
    ...current,
    loading: enabled && current.data === undefined && current.fetching,
    refresh,
  };
}
