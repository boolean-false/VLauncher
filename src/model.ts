import { normalizeVersion } from "./versionRequirement.ts";

export type LocalProfile = {
  main_build?: MainBuild | null;
  id: string;
  name: string;
  icon?: string | null;
  active_revision: string | null;
  voxelcore_version: string | null;
  roots: string[];
  root_requirements?: Record<string, string>;
  packages: {
    id: string;
    kind: "mod" | "library" | "modpack" | "world" | "runtime";
    version: string;
    title?: string | null;
  }[];
  external_packages?: {
    id: string;
    source: "voxelworld";
    project_id: number;
    slug: string;
    version_id: number;
    version: string;
    title: string;
    artifact_sha256: string;
    artifact_size?: number;
  }[];
  manual_packages?: string[];
  problem?: string | null;
  external_game_path?: string | null;
  external_runtime?: {
    path: string;
    executable: string;
    resources: string;
  } | null;
};
export type Runtime = {
  main_build?: MainBuild | null;
  version: string;
  platform: string;
  architecture: string;
  path: string;
};
export type MainBuild = {
  engine_version?: string | null;
  sha: string;
  run_id: number;
  artifact_id: number;
  digest: string;
  size: number;
  created_at: string;
  expires_at: string;
  platform: string;
  architecture: string;
};
export const mainRuntimeId = (build: MainBuild) => `0.0.0-main.${build.artifact_id}+g${build.sha}`;
export const profileRuntimeId = (profile?: LocalProfile) =>
  profile?.main_build ? mainRuntimeId(profile.main_build) : engineVersion(profile);
export const formatVoxelCoreVersion = (version: string) =>
  normalizeVersion(version) || version.trim();
export const mainBuildLabel = (build: MainBuild) => `${build.engine_version ? `${formatVoxelCoreVersion(build.engine_version)} · DEV (main)` : "main"} · ${build.sha.slice(0, 7)} · ${build.created_at.slice(0, 10)}`;
export const profileEngineLabel = (profile: LocalProfile, latestPublishedVersion = "") => profile.main_build ? mainBuildLabel(profile.main_build) : voxelCoreVersionLabel(engineVersion(profile), latestPublishedVersion);
export type GameEvent = {
  profile_id: string;
  stream: string;
  message: string;
  success?: boolean;
};
export type Task = {
  id: number;
  title: string;
  detail: string;
  status: "working" | "done" | "error";
  time: string;
  completed?: number;
  total?: number;
};
export type RunTask = (
  title: string,
  work: (stage: (detail: string) => void) => Promise<unknown>,
) => Promise<boolean>;
export const engineVersion = (profile?: LocalProfile) =>
  profile?.main_build?.engine_version?.trim() || profile?.voxelcore_version?.trim() || "";
export const profileRuntimeContext = (profile?: LocalProfile) => {
  const version = engineVersion(profile);
  return profile?.main_build
    ? {
        kind: "main" as const,
        version,
        commit_sha: profile.main_build.sha,
        platform: profile.main_build.platform as "linux" | "windows" | "macos",
        architecture: profile.main_build.architecture as "x86_64" | "aarch64",
      }
    : { kind: "stable" as const, version };
};
export const mainRuntimeContext = (build: MainBuild) => ({
  kind: "main" as const,
  version: build.engine_version?.trim() || "",
  commit_sha: build.sha,
  platform: build.platform as "linux" | "windows" | "macos",
  architecture: build.architecture as "x86_64" | "aarch64",
});

type SemVer = { core: number[]; prerelease: (number | string)[] };

const parseSemVer = (value: string): SemVer | null => {
  const match = normalizeVersion(value).match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]
      ? match[4].split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part)
      : [],
  };
};

export const compareSemVer = (left: string, right: string) => {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return Number(!a.prerelease.length) - Number(!b.prerelease.length);
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const av = a.prerelease[index];
    const bv = b.prerelease[index];
    if (av === undefined || bv === undefined) return av === undefined ? -1 : 1;
    if (av === bv) continue;
    if (typeof av === "number" && typeof bv === "number") return av - bv;
    if (typeof av === "number") return -1;
    if (typeof bv === "number") return 1;
    return av.localeCompare(bv, "en");
  }
  return 0;
};

export const latestPublishedVoxelCoreVersion = (versions: Iterable<string>) => {
  let latest = "";
  for (const version of versions) {
    if (parseSemVer(version) && (!latest || compareSemVer(version, latest) > 0)) {
      latest = formatVoxelCoreVersion(version);
    }
  }
  return latest;
};

export const isDevelopmentVoxelCoreVersion = (version: string, latestPublishedVersion: string) =>
  !!parseSemVer(version) && !!parseSemVer(latestPublishedVersion) && compareSemVer(version, latestPublishedVersion) > 0;

export const voxelCoreVersionLabel = (version: string, latestPublishedVersion: string) =>
  isDevelopmentVoxelCoreVersion(version, latestPublishedVersion)
    ? `${formatVoxelCoreVersion(version)} · DEV`
    : formatVoxelCoreVersion(version);

export const profileModpack = (profile?: LocalProfile) =>
  profile?.packages.find((pkg) => pkg.kind === "modpack");

export const exactVoxelCoreVersion = (requirement: string) => {
  const match = requirement.trim().match(/^=?\s*(v?\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?)$/);
  return match ? normalizeVersion(match[1]) : "";
};

export function requireEngineVersion(version: string): string {
  if (!version.trim()) {
    throw new Error("Выберите версию VoxelCore в разделе «Управление» профиля.");
  }
  return version.trim();
}

export const friendlyError = (value: unknown) => {
  const text = String(value);
  const translations: [string, string][] = [
    ["profile has no VoxelCore version", "Выберите версию VoxelCore в разделе «Управление» профиля."],
    ["insufficient disk space", "Недостаточно места на диске для этой операции."],
    ["another profile operation is in progress", "Для этого профиля уже выполняется другая операция."],
    ["another VoxelCore operation is in progress", "Другая операция с VoxelCore ещё не завершена."],
    ["download paused by user", "Загрузка приостановлена. Её можно продолжить повтором операции."],
    ["upload paused by user", "Загрузка приостановлена. Черновик сохранён для продолжения."],
    ["artifact hash mismatch", "Архив повреждён или изменился на сервере. Повторите загрузку."],
    ["resolution plan was issued in the future", "Не удалось проверить время плана установки. Включите автоматическую синхронизацию даты, времени и часового пояса Windows, затем повторите установку."],
    ["prepared archive changed after preview", "Подготовленный архив изменился после проверки. Проверьте проект заново."],
    ["\"code\":\"release_exists\"", "Версия с таким номером уже существует. Сначала снимите её с публикации."],
    ["profile does not exist", "Профиль больше не существует."],
    ["runtime package is incompatible", "Эта сборка VoxelCore предназначена для другой системы."],
    ["VoxelCore runtime is not installed", "Нужная версия VoxelCore не установлена."],
    ["a modpack cannot use a temporary main build", "Сборку нельзя создать из временной версии main. Выберите стабильный выпуск VoxelCore."],
    ["a modpack cannot include manually installed packages", "В профиле есть пакеты, добавленные вручную. Удалите или опубликуйте их перед созданием сборки."],
    ["reinstall VoxelWorld packages before creating a modpack", "Переустановите пакеты VoxelWorld, чтобы зафиксировать их размер и контрольную сумму."],
    ["a profile cannot contain multiple modpacks", "В одном профиле не может быть несколько сборок."],
    ["a modpack must be a profile root", "Сборка должна определять профиль целиком."],
    ["a modpack must be installed as a separate profile", "Сборка устанавливается как отдельный профиль, а не как контент существующего профиля."],
  ];
  return translations.find(([fragment]) => text.includes(fragment))?.[1] ?? text;
};
export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} КБ`
    : bytes < 1024 ** 3
      ? `${(bytes / 1024 ** 2).toFixed(1)} МБ`
      : `${(bytes / 1024 ** 3).toFixed(1)} ГБ`;
export const kinds: Record<string, string> = {
  mod: "Контент-пак",
  modpack: "Сборка",
  world: "Карта",
  runtime: "VoxelCore",
};
