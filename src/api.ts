import { requireEngineVersion } from "./model";
import { connectPublicMetadata } from "./publicMetadataCache";
import { clearImageSession } from "./imageCache";
import { resources, consumerSignal } from "./resourceCache";
export type Release = {
  id: string;
  version: string;
  channel: "stable" | "beta" | "alpha";
  voxelcore: string;
  artifact_sha256: string | null;
  artifact_size: number | null;
  download_url: string | null;
  preview_url?: string | null;
  changelog?: string;
  deprecated?: boolean;
  dependencies?: {
    id: string;
    requirement: string;
    kind: "required" | "optional" | "weak" | "conflict";
  }[];
  attestation?: {
    assertion?: {
      manifest?: {
        capabilities?: string[];
        external_packages?: ExternalPackageLock[];
        components?: {
          key: string;
          type: "world";
          title: string;
          strategy: "copy_once";
          artifact_sha256: string;
          artifact_size: number;
          dependencies: { id: string; requirement: string; kind: "required" }[];
        }[];
      };
    };
  } | null;
};

export type Project = {
  id: string;
  slug: string;
  package_id: string | null;
  type: "mod" | "modpack" | "world" | "runtime";
  title: string;
  summary: string;
  license: string | null;
  downloads: number;
  updated_at: string | null;
  latest_release: Release | null;
  cover_url?: string | null;
  categories?: string[];
};

export type ProjectPage = { items: Project[]; total: number };
export type RuntimeRelease = {
  version: string;
  channel: "stable" | "beta" | "alpha";
  artifact_size: number;
  published_at: string;
};
export type ProjectDetail = Project & {
  description: string;
  owner: string;
  organization: string | null;
  gallery_urls?: string[];
};
export type ProjectMedia = {
  id: string;
  kind: "cover" | "gallery" | "description";
  position: number;
  width: number;
  height: number;
  url: string;
};
export const loadProject = (slug: string) =>
  registryRequest<ProjectDetail>(`/projects/${encodeURIComponent(slug)}`);
export const loadReleases = (slug: string) =>
  registryRequest<Release[]>(`/projects/${encodeURIComponent(slug)}/releases`);
export const loadRuntimeReleases = (platform: string, architecture: string) =>
  registryRequest<RuntimeRelease[]>(
    `/runtimes?${new URLSearchParams({ platform, architecture })}`,
  );

export type ResolvedPackage = {
  id: string;
  title?: string | null;
  type: Project["type"];
  version: string;
  channel: "stable" | "beta" | "alpha";
  artifact_sha256: string;
  artifact_size: number;
  download_url: string;
  dependencies: string[];
};

export type ExternalPackageLock = {
  source: "voxelworld";
  id: string;
  title: string;
  project_id: number;
  slug: string;
  version_id: number;
  version: string;
  artifact_sha256: string;
  artifact_size: number;
};

export type SignedInstallPlan = {
  plan: {
    revision: string;
    issued_at: number;
    expires_at: number;
    voxelcore_version: string;
    roots: string[];
    root_requirements: Record<string, string>;
    packages: ResolvedPackage[];
    external_packages: ExternalPackageLock[] | null;
  };
  algorithm: "Ed25519";
  key_id: string;
  payload: string;
  signature: string;
};

export const registryUrl: string =
  import.meta.env.VITE_REGISTRY_URL?.trim() || "https://example.invalid/api/v1";

connectPublicMetadata(resources, registryUrl);

const translatedErrors: Record<string, string> = {
  no_compatible_release: "Для выбранной версии VoxelCore нет совместимого набора пакетов.",
  dependency_cycle: "В зависимостях проекта найден замкнутый цикл.",
  package_conflict: "Выбранные пакеты конфликтуют друг с другом.",
  multiple_modpacks: "В одном профиле не может быть несколько сборок.",
  modpack_must_be_root: "Сборка должна определять отдельный профиль.",
  artifact_unavailable: "Архив выбранной версии временно недоступен.",
  authentication_required: "Сначала войдите в аккаунт.",
  github_oauth_not_configured: "Вход через GitHub пока не настроен на сервере.",
  release_exists: "Версия с таким номером уже существует.",
  project_slug_reserved: "Этот идентификатор зарезервирован после удаления проекта. Для нового проекта выберите другой идентификатор.",
  project_slug_taken: "Этот идентификатор проекта уже занят.",
  package_identifier_pending: "Дождитесь проверки первой версии контент-пака.",
  invalid_image: "Файл не удалось распознать как подходящее изображение.",
  image_too_large: "Изображение превышает ограничение 10 МБ.",
  session_expired: "Сессия завершена. Войдите снова.",
  upload_quota_reached: "Достигнут лимит одновременных загрузок. Завершите или отмените старые.",
  rate_limited: "Слишком много запросов. Подождите немного и повторите.",
  invalid_project_slug: "Идентификатор должен содержать строчные латинские буквы, цифры и подчёркивание.",
  github_username_conflict: "Этот GitHub-профиль уже связан с другой учётной записью.",
};

async function responseError(response: Response, fallback: string): Promise<Error> {
  const data = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  const code = data?.error?.code ?? "";
  return Object.assign(new Error(translatedErrors[code] ?? data?.error?.message ?? fallback), { status: response.status });
}

async function fetchRegistry<T>(
  path: string,
  init?: RequestInit,
  token?: string,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init?.body) headers.set("Content-Type", "application/json");
  const timeout = AbortSignal.timeout(20_000);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const response = await fetch(`${registryUrl}${path}`, { ...init, headers, signal });
  if (!response.ok) {
    if (response.status === 401 && token) clearPrivateCache(token);
    throw await responseError(response, `Сервер вернул ошибку ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const registryKey = (path: string, token?: string) => JSON.stringify([registryUrl, token ?? "", path]);
export const registryCacheable = (path: string) => /^\/(projects(?:[/?]|$)|categories(?:[?]|$)|runtimes(?:[?]|$)|creator\/projects(?:[/?]|$)|organizations(?:[/?]|$)|users\/)/.test(path);
export function invalidateRegistry(token?: string) {
  resources.invalidate(key => { try { const [url, session] = JSON.parse(key); return url === registryUrl && (!session || session === token); } catch { return false; } });
}
function invalidateMutation(path: string, token?: string) {
  if (path.startsWith('/auth/')) return;
  const project = path.match(/^\/creator\/projects\/([^/]+)/)?.[1];
  resources.invalidate(key => {
    try {
      const [url, session, resource] = JSON.parse(key);
      if (url !== registryUrl || session && session !== token) return false;
      if (path.startsWith('/creator/projects')) return resource.startsWith('/projects?') || resource.startsWith('/users/') || resource.startsWith('/categories') || resource === '/creator/projects' || (project && (resource.startsWith(`/projects/${project}`) || resource.startsWith(`/creator/projects/${project}`))) || path.endsWith('/organization') && resource.startsWith('/organizations');
      if (path.startsWith('/organizations')) return resource.startsWith('/organizations') || resource.startsWith('/creator/projects');
      if (/^\/(management|moderation|admin)\//.test(path)) return true;
      return false;
    } catch { return false; }
  });
}
export function clearPrivateCache(token: string) {
  clearImageSession(token);
  resources.invalidate(key => { try { return JSON.parse(key)[1] === token; } catch { return false; } }, true);
}
export async function registryRequest<T>(path: string, init?: RequestInit, token?: string): Promise<T> {
  if (init?.signal?.aborted) throw init.signal.reason;
  const method = init?.method?.toUpperCase() ?? "GET";
  if (method === "GET" && registryCacheable(path) && init?.cache !== "no-store" && (token || !new Headers(init?.headers).has("Authorization"))) {
    const { signal, ...options } = init ?? {};
    return consumerSignal(resources.read(registryKey(path, token), () => fetchRegistry<T>(path, options, token), path.startsWith('/categories') ? 300_000 : 60_000, init?.cache === 'reload'), signal);
  }
  const value = await fetchRegistry<T>(path, init, token);
  if (method !== "GET") invalidateMutation(path, token);
  if (path === '/auth/logout' && token) clearPrivateCache(token);
  return value;
}

export type Account = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  role: string;
};
export type CreatorProject = {
  cover_url?: string | null;
  preview_url?: string | null;
  can_delete?: boolean;
  can_manage_lifecycle?: boolean;
  archived_at?: string | null;
  package_id: string | null;
  downloads?: number;
  id: string;
  slug: string;
  type: Project["type"];
  title: string;
  summary: string;
  description: string;
  license: string | null;
  status: string;
  organization?: string | null;
  categories?: string[];
};
export type DeviceSession = {
  request_id: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};
export type CreatorRelease = {
  review_reason?: string;
  id: string;
  version: string;
  channel: string;
  status: string;
  changelog: string;
  deprecated: boolean;
  deprecation_message: string | null;
};
export type Organization = {
  id: string;
  slug: string;
  name: string;
  description: string;
  role: string;
};
export type ProjectMember = {
  username: string;
  display_name: string | null;
  role: "owner" | "maintainer" | "member";
};
export type ModerationItem = {
  release_id: string;
  slug: string;
  title: string;
  version: string;
  channel: string;
  author: string;
  artifact_size: number;
  artifact_sha256: string;
  manifest: {
    dependencies?: { id: string; requirement?: string; kind?: string }[];
    capabilities?: string[];
    [key: string]: unknown;
  };
};
export type Report = {
  id: string;
  project_slug: string;
  reporter: string;
  reason: string;
  details: string;
  status: string;
};

export const loadAccount = (token: string) =>
  registryRequest<Account>("/auth/me", undefined, token);
export const revokeSession = (token: string) =>
  registryRequest<void>("/auth/logout", { method: "POST" }, token);
export type AccessSession = {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};
export const loadSessions = (token: string) =>
  registryRequest<AccessSession[]>("/auth/sessions", undefined, token);
export const revokeSessionById = (token: string, id: string) =>
  registryRequest<void>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, token);
export const loadCreatorProjects = (token: string) =>
  registryRequest<CreatorProject[]>("/creator/projects", undefined, token);
export const createCreatorProject = (
  token: string,
  project: Omit<
    Pick<CreatorProject, "type" | "title" | "summary" | "description" | "license" | "categories">,
    "type"
  > & { type: Exclude<Project["type"], "runtime"> },
) =>
  registryRequest<CreatorProject>(
    "/creator/projects",
    { method: "POST", body: JSON.stringify(project) },
    token,
  );
export const updateCreatorProject = (
  token: string,
  slug: string,
  project: Partial<
    Pick<CreatorProject, "title" | "summary" | "description" | "license" | "categories">
  >,
) =>
  registryRequest<CreatorProject>(
    `/creator/projects/${slug}`,
    { method: "PATCH", body: JSON.stringify(project) },
    token,
  );
export const deleteCreatorProject = (token: string, slug: string) =>
  registryRequest<{ removed: string }>(
    `/creator/projects/${encodeURIComponent(slug)}`,
    { method: "DELETE" },
    token,
  );
export const loadCreatorReleases = (token: string, slug: string) =>
  registryRequest<CreatorRelease[]>(
    `/creator/projects/${slug}/releases`,
    undefined,
    token,
  );
export const loadProjectMedia = (token: string, slug: string) =>
  registryRequest<ProjectMedia[]>(
    `/creator/projects/${encodeURIComponent(slug)}/media`,
    undefined,
    token,
  );
export async function uploadProjectMedia(
  token: string,
  slug: string,
  kind: "cover" | "gallery" | "description",
  file: File,
): Promise<ProjectMedia> {
  const response = await fetch(
    `${registryUrl}/creator/projects/${encodeURIComponent(slug)}/media/${kind}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    },
  );
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    throw new Error(data?.error?.message ?? `Image upload returned ${response.status}`);
  }
  invalidateMutation(`/creator/projects/${encodeURIComponent(slug)}/media`, token);
  return response.json() as Promise<ProjectMedia>;
}
export const deleteProjectMedia = (token: string, slug: string, mediaId: string) =>
  registryRequest(
    `/creator/projects/${encodeURIComponent(slug)}/media/${mediaId}`,
    { method: "DELETE" },
    token,
  );
export const deprecateRelease = (
  token: string,
  slug: string,
  version: string,
  message: string,
) =>
  registryRequest(
    `/creator/projects/${slug}/releases/${version}/deprecate`,
    { method: "POST", body: JSON.stringify({ message }) },
    token,
  );
export const yankRelease = (token: string, slug: string, version: string) =>
  registryRequest(
    `/creator/projects/${slug}/releases/${version}/yank`,
    { method: "POST", body: JSON.stringify({}) },
    token,
  );
export const setProjectMember = (
  token: string,
  slug: string,
  username: string,
  role: string,
) =>
  registryRequest(
    `/creator/projects/${slug}/members`,
    { method: "PUT", body: JSON.stringify({ username, role }) },
    token,
  );
export const loadProjectMembers = (token: string, slug: string) =>
  registryRequest<ProjectMember[]>(
    `/creator/projects/${encodeURIComponent(slug)}/members`,
    undefined,
    token,
  );
export const removeProjectMember = (token: string, slug: string, username: string) =>
  registryRequest(
    `/creator/projects/${encodeURIComponent(slug)}/members/${encodeURIComponent(username)}`,
    { method: "DELETE" },
    token,
  );
export const loadOrganizations = (token: string) =>
  registryRequest<Organization[]>("/organizations", undefined, token);
export const createOrganization = (
  token: string,
  data: Pick<Organization, "slug" | "name" | "description">,
) =>
  registryRequest<Organization>(
    "/organizations",
    { method: "POST", body: JSON.stringify(data) },
    token,
  );
export const assignOrganization = (
  token: string,
  slug: string,
  organization: string | null,
) =>
  registryRequest(
    `/creator/projects/${slug}/organization`,
    { method: "PUT", body: JSON.stringify({ organization }) },
    token,
  );
export const loadModerationQueue = (token: string) =>
  registryRequest<ModerationItem[]>("/moderation/queue", undefined, token);
export const decideModeration = (
  token: string,
  releaseId: string,
  decision: "approve" | "reject",
  reason: string,
) =>
  registryRequest(
    `/moderation/${releaseId}/${decision}`,
    { method: "POST", body: JSON.stringify({ reason }) },
    token,
  );
export const loadReports = (token: string) =>
  registryRequest<Report[]>("/moderation/reports", undefined, token);
export const resolveReport = (token: string, id: string, resolution: string) =>
  registryRequest(
    `/moderation/reports/${id}/resolve`,
    { method: "POST", body: JSON.stringify({ resolution }) },
    token,
  );
export const createReport = (
  token: string,
  projectSlug: string,
  reason: string,
  details: string,
) =>
  registryRequest(
    "/reports",
    {
      method: "POST",
      body: JSON.stringify({ project_slug: projectSlug, reason, details }),
    },
    token,
  );
export const loadUpload = (token: string, id: string) =>
  registryRequest<{ id: string; status: string; error: string | null }>(
    `/uploads/${id}`,
    undefined,
    token,
  );

export type CategoryOption = { id: string; name: string };
export const loadCategories = (kind: string, signal?: AbortSignal) =>
  registryRequest<CategoryOption[]>(`/categories?${new URLSearchParams({ kind })}`, { signal });

export async function loadProjects(
  query = "",
  kind = "",
  offset = 0,
  signal?: AbortSignal,
  sort = "updated",
  author = "",
  license = "",
  category: string | string[] = "",
  voxelcoreVersion = "",
): Promise<ProjectPage> {
  const parameters = new URLSearchParams({
    limit: "24",
    offset: String(offset),
    sort,
  });
  if (query.trim()) parameters.set("q", query.trim());
  if (kind) parameters.set("kind", kind);
  if (author.trim()) parameters.set("author", author.trim());
  if (license.trim()) parameters.set("license", license.trim());
  for (const id of Array.isArray(category) ? category : [category.trim()]) {
    if (id) parameters.append("category", id);
  }
  if (voxelcoreVersion) parameters.set("voxelcore_version", voxelcoreVersion);
  return registryRequest<ProjectPage>(`/projects?${parameters}`, { signal });
}

export async function resolveProject(
  slugs: string[],
  voxelcoreVersion: string,
  requirements: Record<string, string> = {},
  channels: string[] = ["stable"],
  locked: Record<string, string> = {},
  directProject?: { id: string; version: string },
): Promise<SignedInstallPlan> {
  voxelcoreVersion = requireEngineVersion(voxelcoreVersion);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const direct = new Map<string, string>();
  if (directProject) direct.set(directProject.id, directProject.version);
  for (const id of slugs.filter((item) => uuid.test(item))) {
    const requirement = requirements[id] ?? (locked[id] ? `=${locked[id]}` : "");
    if (!requirement.startsWith("=") || !requirement.slice(1)) {
      throw new Error(`Для проекта ${id} не зафиксирована точная версия.`);
    }
    direct.set(id, requirement.slice(1));
  }
  const packageRoots = slugs.filter((id) => !direct.has(id));
  const response = await fetch(`${registryUrl}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      voxelcore_version: voxelcoreVersion,
      roots: packageRoots.map((id) => ({ id, requirement: requirements[id] ?? "*" })),
      channels,
      locked: Object.fromEntries(Object.entries(locked).filter(([id]) => !direct.has(id))),
      projects: [...direct].map(([id, version]) => ({ id, version })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw await responseError(response, `Resolver вернул ошибку ${response.status}`);
  }
  return response.json() as Promise<SignedInstallPlan>;
}
