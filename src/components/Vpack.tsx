import { listen } from "@tauri-apps/api/event";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { Modal } from "./ui";
import { RuntimeProgress } from "./ExperimentalBuildPicker";
import {
  formatBytes,
  friendlyError,
  isProjectProfile,
  type LocalProfile,
  type RunTask,
  type Task,
} from "../model";

export type VpackPreview = {
  manifest: {
    name: string;
    voxelcore_version: string;
    main_build?: { sha: string } | null;
    packages: { id: string; version: string; embedded: string | null }[];
    worlds: boolean;
    settings: boolean;
    local_project: boolean;
    local_runtime: unknown | null;
  };
  archive_sha256: string;
  download_size: number;
  embedded_size: number;
  local_mods: number;
};

export function VpackImport({
  preview,
  path,
  busy,
  task,
  run,
  close,
  imported,
  play,
}: {
  preview: VpackPreview;
  path: string;
  busy: boolean;
  task?: Task;
  run: RunTask;
  close: () => void;
  imported: (profile: LocalProfile) => Promise<void>;
  play: (profile: LocalProfile) => void;
}) {
  const [error, setError] = useState("");
  const [finalizing, setFinalizing] = useState(false);
  const [created, setCreated] = useState<LocalProfile | null>(null);
  const m = preview.manifest;
  if (created)
    return (
      <Modal
        title="Сборка добавлена"
        className="vpack-modal"
        busy={busy || finalizing}
        close={close}
      >
        <p>«{created.name}»</p>
        {error && <p className="notice error">{error}</p>}
        <div className="actions repair-actions">
          <button disabled={busy || finalizing} onClick={close}>
            Открыть профиль
          </button>
          <button
            className="primary"
            disabled={busy || finalizing}
            onClick={() => play(created)}
          >
            Играть
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal
      title={`Импортировать «${m.name}»?`}
      className="vpack-modal"
      busy={busy}
      close={close}
    >
      <p>
        VoxelCore {m.voxelcore_version}
        {m.main_build ? " · DEV" : ""}
      </p>
      <div className="vpack-summary">
        <span>{m.local_project ? "Проект" : "Моды и пакеты"}</span>
        <strong>
          {m.local_project ? "Целиком" : m.packages.length + preview.local_mods}
        </strong>
        {preview.download_size > 0 && (
          <>
            <span>Нужно скачать</span>
            <strong>{formatBytes(preview.download_size)}</strong>
          </>
        )}
      </div>
      {(m.worlds || m.settings || !!m.local_runtime) && (
        <p className="muted">
          В архиве:{" "}
          {[
            m.worlds && "миры",
            m.settings && "настройки",
            !!m.local_runtime && "движок",
          ]
            .filter(Boolean)
            .join(", ")}
          .
        </p>
      )}
      {!!m.packages.length && (
        <details>
          <summary>Состав сборки</summary>
          <ul className="vpack-packages">
            {m.packages.map((p) => (
              <li key={p.id}>
                <span>
                  {p.id} · {p.version}
                </span>
                <small>{p.embedded ? "В архиве" : "Скачать"}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="notice error">{error}</p>}
      <RuntimeProgress
        task={task}
        cancel={busy ? () => void invoke("cancel_transfer") : undefined}
      />
      <div className="actions repair-actions">
        <button disabled={busy} onClick={close}>
          Отмена
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            setError("");
            let result: LocalProfile | undefined;
            const ok = await run("Импорт vpack", async (stage) => {
              try {
                stage("Проверяем архив и подготавливаем сборку…");
                result = await invoke<LocalProfile>("import_vpack", {
                  path,
                  expectedHash: preview.archive_sha256,
                });
              } catch (reason) {
                setError(friendlyError(reason));
                throw reason;
              }
            });
            if (ok && result) {
              setCreated(result);
              setFinalizing(true);
              try {
                await imported(result);
              } catch (reason) {
                setError(friendlyError(reason));
              } finally {
                setFinalizing(false);
              }
            }
          }}
        >
          {busy ? "Импортируем…" : "Импортировать"}
        </button>
      </div>
    </Modal>
  );
}

type PreparedExport = {
  token: string;
  preview: VpackPreview;
  archive_size: number;
};

export function VpackExport({
  profile,
  busy,
  run,
}: {
  profile: LocalProfile;
  busy: boolean;
  run: RunTask;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <section className="setting-row">
        <div>
          <h3>
            {isProjectProfile(profile)
              ? "Поделиться проектом"
              : "Поделиться сборкой"}
          </h3>
        </div>
        <button disabled={busy} onClick={() => setOpened(true)}>
          Экспортировать vpack
        </button>
      </section>
      {opened && (
        <VpackExportDialog
          key={profile.id}
          profile={profile}
          busy={busy}
          run={run}
          close={() => setOpened(false)}
        />
      )}
    </>
  );
}

function VpackExportDialog({
  profile,
  busy,
  run,
  close,
}: {
  profile: LocalProfile;
  busy: boolean;
  run: RunTask;
  close: () => void;
}) {
  const [worlds, setWorlds] = useState(false);
  const [settings, setSettings] = useState(false);
  const [working, setWorking] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<PreparedExport | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    if (!working) return;
    const subscription = listen<string>("vpack-stage", ({ payload }) =>
      setStage(payload),
    );
    return () => {
      void subscription.then((fn) => fn());
    };
  }, [working]);
  useEffect(() => {
    const token = prepared?.token;
    return () => {
      if (token) void invoke("discard_vpack_export", { token }).catch(() => {});
    };
  }, [prepared?.token]);
  const references =
    prepared?.preview.manifest.packages.filter((p) => !p.embedded).length ?? 0;
  const embedded =
    (prepared?.preview.manifest.packages.filter((p) => p.embedded).length ??
      0) + (prepared?.preview.local_mods ?? 0);
  return (
    <Modal
      title={
        saved
          ? "Архив сохранён"
          : prepared
            ? "Сборка готова к экспорту"
            : "Экспорт сборки"
      }
      className="vpack-modal"
      busy={busy}
      close={close}
    >
      <p>
        «{profile.name}» · VoxelCore {profile.voxelcore_version}
      </p>
      {saved ? (
        <p className="vpack-saved-path selectable" title={saved}>
          {saved.split(/[\\/]/).pop()}
        </p>
      ) : prepared ? (
        <>
          <div className="vpack-summary">
            <span>
              {prepared.preview.manifest.local_project
                ? "Проект"
                : "Моды и пакеты"}
            </span>
            <strong>
              {prepared.preview.manifest.local_project
                ? "Целиком"
                : references + embedded}
            </strong>
            <span>Размер файла</span>
            <strong>{formatBytes(prepared.archive_size)}</strong>
            {prepared.preview.download_size > 0 && (
              <>
                <span>Скачать при импорте</span>
                <strong>{formatBytes(prepared.preview.download_size)}</strong>
              </>
            )}
          </div>
          {(worlds || settings) && (
            <p className="muted">
              Включены:{" "}
              {[worlds && "миры", settings && "настройки"]
                .filter(Boolean)
                .join(", ")}
              .
            </p>
          )}
          {(embedded > 0 || references > 0) && (
            <details>
              <summary>Состав сборки</summary>
              <ul className="vpack-packages">
                {prepared.preview.manifest.packages.map((p) => (
                  <li key={p.id}>
                    <span>
                      {p.id} · {p.version}
                    </span>
                    <small>{p.embedded ? "В архиве" : "Скачать"}</small>
                  </li>
                ))}
                {prepared.preview.local_mods > 0 && (
                  <li>
                    <span>Локальные моды</span>
                    <small>{prepared.preview.local_mods} в архиве</small>
                  </li>
                )}
              </ul>
            </details>
          )}
        </>
      ) : (
        <>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={worlds}
              disabled={busy}
              onChange={(e) => setWorlds(e.target.checked)}
            />
            {isProjectProfile(profile)
              ? "Включить прохождение"
              : "Включить миры"}
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={settings}
              disabled={busy}
              onChange={(e) => setSettings(e.target.checked)}
            />
            Включить настройки
          </label>
          {profile.external_runtime && (
            <p className="muted">
              Архив с локальным движком подойдёт только для этой системы.
            </p>
          )}
          {profile.external_project_path && (
            <p className="muted">Проект будет включён целиком.</p>
          )}
        </>
      )}
      {error && <p className="notice error">{error}</p>}
      {working && (
        <div className="install-progress" role="status">
          <strong>{stage}</strong>
          <progress aria-label="Подготовка архива" />
          {!prepared && (
            <button onClick={() => void invoke("cancel_transfer")}>
              Отменить подготовку
            </button>
          )}
        </div>
      )}
      <div className="actions repair-actions">
        {saved ? (
          <>
            <button disabled={busy} onClick={close}>
              Готово
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void revealItemInDir(saved).catch((reason) =>
                  setError(friendlyError(reason)),
                )
              }
            >
              Показать файл
            </button>
          </>
        ) : prepared ? (
          <>
            <button
              disabled={busy}
              onClick={() => {
                setPrepared(null);
                setError("");
              }}
            >
              Изменить состав
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setError("");
                try {
                  const path = await save({
                    defaultPath: `${profile.name.replace(/[<>:"/\\|?*]/g, "_")}.vpack`,
                    filters: [
                      { name: "Сборка VLauncher", extensions: ["vpack"] },
                    ],
                  });
                  if (!path) return;
                  setError("");
                  setWorking(true);
                  setStage("Сохраняем архив…");
                  try {
                    const ok = await run("Сохранение vpack", async () => {
                      try {
                        await invoke("save_vpack_export", {
                          token: prepared.token,
                          path,
                        });
                      } catch (reason) {
                        setError(friendlyError(reason));
                        throw reason;
                      }
                    });
                    if (ok) {
                      setSaved(path);
                      setPrepared(null);
                    }
                  } finally {
                    setWorking(false);
                  }
                } catch (reason) {
                  setError(friendlyError(reason));
                }
              }}
            >
              Сохранить vpack
            </button>
          </>
        ) : (
          <>
            <button disabled={busy} onClick={close}>
              Отмена
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={async () => {
                setError("");
                setWorking(true);
                setStage("Проверяем и упаковываем файлы…");
                try {
                  await run("Подготовка vpack", async () => {
                    try {
                      setPrepared(
                        await invoke<PreparedExport>("prepare_vpack_export", {
                          profileId: profile.id,
                          worlds,
                          settings,
                        }),
                      );
                    } catch (reason) {
                      setError(friendlyError(reason));
                      throw reason;
                    }
                  });
                } finally {
                  setWorking(false);
                }
              }}
            >
              Подготовить архив
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
