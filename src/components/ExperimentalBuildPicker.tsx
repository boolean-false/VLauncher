import { useEffect, useId, useState } from "react";
import {
  mainBuildLabel,
  type MainBuild,
  type Runtime,
  type Task,
} from "../model";
import { loadMainBuilds, type MainCatalog } from "../runtimePlanning";
import { ErrorNotice } from "./ui";
import { Select } from "./Select";

export function ExperimentalBuildPicker({
  runtimes,
  value,
  onChange,
  busy,
}: {
  runtimes: Runtime[];
  value: MainBuild | null;
  onChange: (build: MainBuild | null) => void;
  busy: boolean;
}) {
  const [catalog, setCatalog] = useState<MainCatalog | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void loadMainBuilds()
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch((reason) => {
        if (active) setError(String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  const installed = runtimes.flatMap((runtime) =>
    runtime.main_build?.engine_version ? [runtime.main_build] : [],
  );
  const builds = [
    ...(catalog?.builds ?? []),
    ...installed.filter(
      (build) =>
        !catalog?.builds.some((item) => item.artifact_id === build.artifact_id),
    ),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const first = builds[0];
  useEffect(() => {
    if (!loading && !value && first) onChange(first);
  }, [loading, value, first?.artifact_id, onChange]);
  return (
    <div className="experimental-build-picker">
      {loading && <p role="status">Ищем доступные сборки…</p>}
      {error && (
        <ErrorNotice retry={() => setAttempt((n) => n + 1)}>
          {error}
        </ErrorNotice>
      )}
      {!loading && !error && !builds.length && (
        <p className="notice">DEV-сборок для вашей системы пока нет.</p>
      )}
      {value && <p>{mainBuildLabel(value)}</p>}
      {catalog &&
        catalog.builds.length > 0 &&
        catalog.builds[0].sha !== catalog.head_sha && (
          <p className="muted">
            Более свежая версия исходников пока не выпущена в виде готовой
            сборки для вашей системы.
          </p>
        )}
      {builds.length > 0 && (
        <details>
          <summary>Другие сборки и технические подробности</summary>
          <label>
            Сборка VoxelCore
            <Select
              disabled={busy || loading}
              value={value?.artifact_id ?? ""}
              onChange={(event) =>
                onChange(
                  builds.find(
                    (build) => build.artifact_id === Number(event.target.value),
                  ) ?? null,
                )
              }
            >
              {!value && (
                <option value="" disabled>
                  Выберите сборку
                </option>
              )}
              {builds.map((build) => (
                <option key={build.artifact_id} value={build.artifact_id}>
                  {mainBuildLabel(build)} · {build.sha.slice(0, 7)}
                  {installed.some(
                    (item) => item.artifact_id === build.artifact_id,
                  )
                    ? " · скачана"
                    : ""}
                </option>
              ))}
            </Select>
          </label>
          {value && (
            <p className="selectable">
              Коммит: {value.sha} · Артефакт: {value.artifact_id}
            </p>
          )}
        </details>
      )}
    </div>
  );
}

export function ExperimentalDestination({
  copy,
  onChange,
  busy,
}: {
  copy: boolean;
  onChange: (copy: boolean) => void;
  busy: boolean;
}) {
  const group = useId();
  return (
    <fieldset className="experimental-destination" disabled={busy}>
      <legend>Где применить изменения</legend>
      <label className="checkbox-row">
        <input
          type="radio"
          name={group}
          checked={copy}
          onChange={() => onChange(true)}
        />
        В копии профиля с мирами и настройками (рекомендуется)
      </label>
      <label className="checkbox-row">
        <input
          type="radio"
          name={group}
          checked={!copy}
          onChange={() => onChange(false)}
        />
        В выбранном профиле
      </label>
      <small>
        {copy
          ? "Исходный профиль сохранится. Копия займёт дополнительное место на диске."
          : "Возврат прежней версии движка не восстанавливает изменённые миры. Сохраните их резервную копию перед запуском."}
      </small>
    </fieldset>
  );
}

export function RuntimeProgress({
  task,
  cancel,
}: {
  task?: Task;
  cancel?: () => void;
}) {
  if (!task || task.status !== "working") return null;
  return (
    <div className="install-progress" role="status">
      <strong>{task.detail || "Подготовка…"}</strong>
      {!!task.total && (
        <progress
          max={task.total}
          value={Math.min(task.completed ?? 0, task.total)}
          aria-label="Прогресс загрузки"
        />
      )}
      {cancel && (
        <button type="button" onClick={cancel}>
          Отменить загрузку
        </button>
      )}
    </div>
  );
}
