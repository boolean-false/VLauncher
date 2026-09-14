import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { registryRequest, type CategoryOption, type ProjectPage } from "./api";

export type VoxelWorldTag = { id: number; title: string };
export type VoxelWorldAuthor = { id: number; name: string; avatar: string | null };
export type VoxelWorldMod = {
  id: number;
  slug: string;
  title: string;
  description: string;
  detail_description?: string | null;
  downloads: number;
  likes: number;
  last_update_date: string | null;
  author: VoxelWorldAuthor;
  contributors?: VoxelWorldAuthor[];
  tags: VoxelWorldTag[];
  logo_url: string | null;
  links?: { id: number; type: string; url: string }[];
};
export type VoxelWorldVersion = {
  id: number;
  version_number: string;
  changelog: string | null;
  detail_changelog?: string | null;
  status: { id: number; title: string };
  engine: { id: number; version_number: string }[];
  dependencies?: (VoxelWorldVersion & {
    project: { id: number; slug: string; title: string; type: string };
  })[];
  created_at: string | null;
};

type VoxelWorldPage = {
  data: VoxelWorldMod[];
  meta: { current_page: number; last_page: number; total: number };
};
type TagResponse = { data: VoxelWorldTag[] };
type VersionPage = {
  data: VoxelWorldVersion[];
  meta: { current_page: number; last_page: number; total: number };
};

const tagCacheKey = "vlauncher.voxelworld.tags.v1";
const tagCacheLifetime = 24 * 60 * 60 * 1000;

function cachedTags(): { data?: VoxelWorldTag[]; fresh: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(tagCacheKey) ?? "null") as {
      at?: number;
      data?: VoxelWorldTag[];
    } | null;
    const valid =
      saved &&
      typeof saved.at === "number" &&
      Array.isArray(saved.data) &&
      saved.data.every(
        (tag) => Number.isInteger(tag.id) && typeof tag.title === "string",
      );
    return {
      data: valid ? saved.data : undefined,
      fresh: !!valid && Date.now() - saved.at! < tagCacheLifetime,
    };
  } catch {
    return { fresh: false };
  }
}

async function request<T>(path: string, params = new URLSearchParams()) {
  return invoke<T>("voxelworld_request", { path, query: params.toString() });
}

type Resource<T> = {
  data?: T;
  error: string;
  loading: boolean;
  fetching: boolean;
  refresh: () => void;
};

function useRequest<T>(
  key: string,
  load: () => Promise<T>,
  enabled: boolean,
  initial?: T,
): Resource<T> {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    key: string;
    data?: T;
    error: string;
    fetching: boolean;
  }>({ key, data: initial, error: "", fetching: enabled });
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState((old) => ({
      key,
      data: old.key === key ? old.data : initial,
      error: "",
      fetching: true,
    }));
    void loadRef.current().then(
      (data) => alive && setState({ key, data, error: "", fetching: false }),
      (reason) =>
        alive &&
        setState((old) => ({
          key,
          data: old.key === key ? old.data : initial,
          error: String(reason),
          fetching: false,
        })),
    );
    return () => {
      alive = false;
    };
  }, [key, enabled, retry, initial]);
  const refresh = useCallback(() => setRetry((value) => value + 1), []);
  const current = state.key === key ? state : { key, data: initial, error: "", fetching: enabled };
  return {
    data: current.data,
    error: current.error,
    fetching: enabled && current.fetching,
    loading: enabled && current.fetching && current.data === undefined,
    refresh,
  };
}

export function useVoxelWorldTags(enabled: boolean) {
  const cache = useRef(cachedTags()).current;
  return useRequest(
    "voxelworld:tags:mods",
    async () => {
      const response = await request<TagResponse>(
        "tags",
        new URLSearchParams({ type: "mods" }),
      );
      try {
        localStorage.setItem(
          tagCacheKey,
          JSON.stringify({ at: Date.now(), data: response.data }),
        );
      } catch {
        // Кэш необязателен: без него список просто загрузится снова.
      }
      return response.data;
    },
    enabled && !cache.fresh,
    cache.data,
  );
}

async function loadAllVoxelWorldMods(params: URLSearchParams) {
  const firstParams = new URLSearchParams(params);
  firstParams.set("page", "1");
  firstParams.set("item_count", "100");
  const first = await request<VoxelWorldPage>("mods", firstParams);
  const pages = Array.from(
    { length: Math.max(0, first.meta.last_page - 1) },
    (_, index) => index + 2,
  );
  const rest = await Promise.all(
    pages.map((page) => {
      const next = new URLSearchParams(params);
      next.set("page", String(page));
      next.set("item_count", "100");
      return request<VoxelWorldPage>("mods", next);
    }),
  );
  return {
    items: [first, ...rest].flatMap((page) => page.data),
    total: first.meta.total,
  };
}

export function useVoxelWorldMods(params: URLSearchParams, enabled: boolean) {
  const key = `voxelworld:mods:${params}`;
  return useRequest(key, () => loadAllVoxelWorldMods(params), enabled);
}

async function loadAllRegistryProjects(params: URLSearchParams) {
  const firstParams = new URLSearchParams(params);
  firstParams.set("offset", "0");
  firstParams.set("limit", "100");
  const first = await registryRequest<ProjectPage>(`/projects?${firstParams}`);
  const offsets = Array.from(
    { length: Math.max(0, Math.ceil(first.total / 100) - 1) },
    (_, index) => (index + 1) * 100,
  );
  const rest = await Promise.all(
    offsets.map((offset) => {
      const next = new URLSearchParams(params);
      next.set("offset", String(offset));
      next.set("limit", "100");
      return registryRequest<ProjectPage>(`/projects?${next}`);
    }),
  );
  return {
    items: [first, ...rest].flatMap((page) => page.items),
    total: first.total,
  };
}

export function useAllRegistryProjects(params: URLSearchParams, enabled: boolean) {
  const key = `vspace:all-projects:${params}`;
  return useRequest(key, () => loadAllRegistryProjects(params), enabled);
}

export function useVoxelWorldMod(slug: string, enabled = true) {
  return useRequest(
    `voxelworld:mod:${slug}`,
    async () => (await request<{ data: VoxelWorldMod }>(`mods/${slug}`)).data,
    enabled && !!slug,
  );
}

async function loadAllVoxelWorldVersions(slug: string) {
  const first = await request<VersionPage>(
    `mods/${slug}/versions`,
    new URLSearchParams({ page: "1", item_count: "100", sortOrder: "desc" }),
  );
  const rest = await Promise.all(
    Array.from(
      { length: Math.max(0, first.meta.last_page - 1) },
      (_, index) => index + 2,
    ).map((page) =>
      request<VersionPage>(
        `mods/${slug}/versions`,
        new URLSearchParams({
          page: String(page),
          item_count: "100",
          sortOrder: "desc",
        }),
      ),
    ),
  );
  return [first, ...rest].flatMap((page) => page.data);
}

export function useVoxelWorldVersions(slug: string) {
  return useRequest(
    `voxelworld:versions:${slug}`,
    () => loadAllVoxelWorldVersions(slug),
    !!slug,
  );
}

export function useVoxelWorldVersion(slug: string, versionId: number) {
  return useRequest(
    `voxelworld:version:${slug}:${versionId}`,
    async () =>
      (
        await request<{ data: VoxelWorldVersion }>(
          `mods/${slug}/versions/${versionId}`,
        )
      ).data,
    !!slug && versionId > 0,
  );
}

const vspaceAliases: Record<string, string> = {
  bioms: "biomes",
  mechanics: "mechanisms",
};
const tagNames: Record<string, string> = {
  api: "API",
  biomes: "Биомы",
  blocks: "Блоки",
  energy: "Энергия",
  game_mode: "Режим игры",
  generation: "Генерация",
  magic: "Магия",
  mechanisms: "Механики",
  mobs: "Мобы",
  network: "Сеть",
  sounds: "Звуки",
  tools: "Инструменты",
};

export function voxelWorldCategoryId(title: string) {
  return Object.entries(vspaceAliases).find(([, external]) => external === title)?.[0] ?? title;
}

export function voxelWorldTagForCategory(
  category: string,
  tags: VoxelWorldTag[],
) {
  const title = vspaceAliases[category] ?? category;
  return tags.find((tag) => tag.title === title);
}

export function mergeModCategories(
  vspace: CategoryOption[],
  voxelWorld: VoxelWorldTag[],
) {
  const merged = new Map(vspace.map((item) => [item.id, item]));
  for (const tag of voxelWorld) {
    const id = voxelWorldCategoryId(tag.title);
    if (!merged.has(id))
      merged.set(id, { id, name: tagNames[tag.title] ?? tag.title });
  }
  return [...merged.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "ru"),
  );
}

export function voxelWorldTagName(title: string) {
  return tagNames[title] ?? title;
}
