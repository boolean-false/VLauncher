import type { GameEvent } from "./model";

export function gameFailureLines(event: GameEvent, logs: GameEvent[]) {
  return (
    event.output_tail ??
    logs
      .filter(
        (line) =>
          line.profile_id === event.profile_id &&
          (line.stream === "stdout" || line.stream === "stderr"),
      )
      .slice(-80)
      .map(({ stream, message }) => ({ stream, message }))
  );
}

export function gameFailureReport(
  profileName: string,
  engine: string,
  event: GameEvent,
  logs: GameEvent[],
) {
  const details = [
    `Профиль: ${profileName}`,
    `VoxelCore: ${event.runtime_version || engine || "версия не указана"}`,
    `Завершение: ${event.message}`,
    event.exit_code != null ? `Код завершения: ${event.exit_code}` : null,
    event.signal != null ? `Сигнал: ${event.signal}` : null,
    event.duration_ms != null
      ? `Время работы: ${(event.duration_ms / 1000).toFixed(1)} с`
      : null,
    "",
    "Последние строки вывода игры:",
    ...gameFailureLines(event, logs).map(
      (line) => `[${line.stream}] ${line.message}`,
    ),
  ];
  return details.filter((line) => line !== null).join("\n");
}
