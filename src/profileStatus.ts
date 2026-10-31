export type LaunchPhase = "checking" | "installing" | "launching";
export type ProfileState =
  | "unavailable"
  | "failed"
  | "running"
  | LaunchPhase
  | "version_required"
  | "install_required"
  | "ready";

export function profileStatus({
  running,
  phase,
  problem,
  error,
  version,
  installed,
}: {
  running: boolean;
  phase?: LaunchPhase;
  problem?: string | null;
  error?: string | null;
  version: string;
  installed: boolean;
}): { state: ProfileState; label: string; action: string } {
  if (running)
    return {
      state: "running",
      label: "Игра запущена",
      action: "Завершить игру",
    };
  if (phase === "checking")
    return { state: phase, label: "Проверяем игру…", action: "Проверяем…" };
  if (phase === "installing")
    return {
      state: phase,
      label: "Скачиваем и устанавливаем…",
      action: "Устанавливаем…",
    };
  if (phase === "launching")
    return { state: phase, label: "Запускаем игру…", action: "Запускаем…" };
  if (problem)
    return {
      state: "unavailable",
      label: "Нужно проверить профиль",
      action: "Проверить профиль",
    };
  if (!version)
    return {
      state: "version_required",
      label: "Выберите версию игры",
      action: "Выбрать версию",
    };
  if (error)
    return {
      state: "failed",
      label: "Запуск не завершён",
      action: installed ? "Повторить запуск" : "Повторить установку",
    };
  return installed
    ? { state: "ready", label: "Готов к запуску", action: "Играть" }
    : {
        state: "install_required",
        label: "Нужна установка",
        action: "Установить и играть",
      };
}
