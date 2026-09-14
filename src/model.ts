export type LocalProfile = {
  main_build?: MainBuild | null;
  id: string;
  name: string;
  icon?: string | null;
  active_revision: string | null;
  voxelcore_version: string | null;
  roots: string[];
  root_requirements?: Record<string, string>;
  packages: { id: string; version: string; title?: string | null }[];
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
export const mainBuildLabel = (build: MainBuild) => `${build.engine_version ? `${build.engine_version} · develop (main)` : "main"} · ${build.sha.slice(0, 7)} · ${build.created_at.slice(0, 10)}`;
export const profileEngineLabel = (profile: LocalProfile) => profile.main_build ? mainBuildLabel(profile.main_build) : engineVersion(profile);
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
};
export type RunTask = (
  title: string,
  work: (stage: (detail: string) => void) => Promise<unknown>,
) => Promise<boolean>;
export const engineVersion = (profile?: LocalProfile) =>
  profile?.main_build?.engine_version?.trim() || profile?.voxelcore_version?.trim() || "";

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
