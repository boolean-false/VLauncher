import { useEffect, useRef, useState } from "react";
import { findContentUpdates } from "./contentUpdates";
import { loadReleases, resolveProject, type SignedInstallPlan } from "./api";
import { friendlyError, type LocalProfile } from "./model";

export type ContentUpdates = {
  plan?: SignedInstallPlan;
  versions: Record<string, string>;
  newer: Record<string, string>;
  channels: string[];
  error?: string;
  loading?: boolean;
};
const cacheLifetime = 120_000;
const cacheLimit = 30;
const cache = new Map<string, { time: number; value: ContentUpdates }>();

export function useContentUpdates(
  profile: LocalProfile | undefined,
  active: boolean,
) {
  const key = JSON.stringify(
    profile
      ? [
          profile.id,
          profile.active_revision,
          profile.packages,
          profile.roots,
          profile.root_requirements,
          profile.main_build,
          profile.voxelcore_version,
        ]
      : null,
  );
  const [generation, setGeneration] = useState(0);
  const refreshRequested = useRef(false);
  const [state, setState] = useState<{ key: string; value: ContentUpdates }>();
  useEffect(() => {
    if (!active || !profile?.roots.length) return;
    let cancelled = false;
    const saved = cache.get(key);
    if (saved && Date.now() - saved.time < cacheLifetime) {
      setState({ key, value: saved.value });
      return;
    }
    const force = refreshRequested.current;
    refreshRequested.current = false;
    setState({
      key,
      value: { versions: {}, newer: {}, channels: [], loading: true },
    });
    void (async () => {
      const value = await findContentUpdates(
        profile,
        (id, version) => loadReleases(id, version, force),
        resolveProject,
      );
      if (cancelled) return;
      cache.set(key, { time: Date.now(), value });
      if (cache.size > cacheLimit) cache.delete(cache.keys().next().value!);
      setState({ key, value });
    })().catch((error) => {
      if (!cancelled)
        setState({
          key,
          value: {
            versions: {},
            newer: {},
            channels: [],
            error: friendlyError(error),
          },
        });
    });
    return () => {
      cancelled = true;
    };
  }, [key, active, generation]);
  return {
    ...(state && state.key === key
      ? state.value
      : { versions: {}, newer: {}, channels: [] }),
    refresh: () => {
      cache.delete(key);
      refreshRequested.current = true;
      setGeneration((value) => value + 1);
    },
  };
}
