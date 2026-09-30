import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  friendlyError,
  profileEngineLabel,
  type LocalProfile,
  type RunTask,
} from "../model";
import { useLocalResource } from "../useLocalResource";
import { ErrorNotice, Modal } from "./ui";
import { Select } from "./Select";

type SettingsInfo = {
  controls: boolean;
  settings: boolean;
  can_restore: boolean;
};

export function ProfileSettingsTransfer({
  profile,
  profiles,
  running,
  busy,
  run,
  refresh,
}: {
  profile: LocalProfile;
  profiles: LocalProfile[];
  running: Set<string>;
  busy: boolean;
  run: RunTask;
  refresh: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"import" | "restore" | null>(null);
  const sources = profiles.filter(
    (item) => item.id !== profile.id && !item.problem,
  );
  const [sourceId, setSourceId] = useState("");
  const source = sources.find((item) => item.id === sourceId);
  const [info, setInfo] = useState<SettingsInfo | null>(null);
  const [controls, setControls] = useState(true);
  const [settings, setSettings] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const target = useLocalResource<SettingsInfo>("profile_settings_info", {
    profileId: profile.id,
  });
  useEffect(() => {
    let active = true;
    setInfo(null);
    setError("");
    setLoading(false);
    if (mode !== "import" || !sourceId) return;
    setLoading(true);
    void invoke<SettingsInfo>("profile_settings_info", { profileId: sourceId })
      .then((value) => {
        if (active) {
          setInfo(value);
          setControls(value.controls);
          setSettings(false);
        }
      })
      .catch((reason) => {
        if (active) setError(friendlyError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, sourceId, attempt]);
  const show = (next: "import" | "restore") => {
    setMode(next);
    setError("");
    setDone(false);
    setSourceId(sources.find((item) => !running.has(item.id))?.id ?? "");
  };
  const apply = async () => {
    setError("");
    const ok = await run(
      mode === "restore" ? "Восстановление настроек" : "Импорт настроек",
      async () => {
        try {
          if (mode === "restore")
            await invoke("restore_profile_settings", { profileId: profile.id });
          else
            await invoke("import_profile_settings", {
              profileId: profile.id,
              sourceId,
              controls,
              settings,
            });
          setDone(true);
          await refresh();
          target.refresh();
        } catch (reason) {
          setDone(false);
          setError(friendlyError(reason));
          throw reason;
        }
      },
    );
    return ok;
  };
  return (
    <section className="setting-row">
      <div>
        <h3>Настройки игры</h3>
        <p>
          Перенесите горячие клавиши и, по желанию, остальные настройки из
          другого профиля.
        </p>
      </div>
      <div className="actions">
        <button
          disabled={busy || !sources.length}
          onClick={() => show("import")}
        >
          Импортировать из профиля…
        </button>
        {target.data?.can_restore && (
          <button disabled={busy} onClick={() => show("restore")}>
            Отменить последний импорт…
          </button>
        )}
      </div>
      {target.error && (
        <ErrorNotice retry={target.refresh}>{target.error}</ErrorNotice>
      )}
      {mode && (
        <Modal
          title={
            mode === "restore"
              ? "Восстановить настройки до импорта"
              : "Импорт настроек игры"
          }
          close={() => setMode(null)}
          busy={busy}
        >
          {done ? (
            <>
              <p className="notice success" role="status">
                {mode === "restore"
                  ? "Прежние настройки восстановлены."
                  : "Настройки перенесены. Отменить последний импорт можно в управлении профилем."}
              </p>
              <div className="modal-actions">
                <button className="primary" onClick={() => setMode(null)}>
                  Готово
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                Профиль: <strong>{profile.name}</strong>
              </p>
              {mode === "import" ? (
                <>
                  <label>
                    Взять настройки из профиля
                    <Select
                      aria-label="Профиль с настройками"
                      disabled={busy}
                      value={sourceId}
                      onChange={(event) => setSourceId(event.target.value)}
                    >
                      <option value="" disabled>
                        Выберите профиль
                      </option>
                      {sources.map((item) => (
                        <option
                          key={item.id}
                          value={item.id}
                          disabled={running.has(item.id)}
                        >
                          {item.name} · {profileEngineLabel(item)}
                          {running.has(item.id) ? " · игра запущена" : ""}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {sources.some((item) => running.has(item.id)) && (
                    <small>
                      Для переноса завершите игру в исходном профиле.
                    </small>
                  )}
                  {loading && <p role="status">Читаем доступные настройки…</p>}
                  {info && (
                    <fieldset className="settings-transfer-options">
                      <legend>Что перенести</legend>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={controls}
                          disabled={busy || !info.controls}
                          onChange={(event) =>
                            setControls(event.target.checked)
                          }
                        />
                        Горячие клавиши{!info.controls && " — ещё не сохранены"}
                      </label>
                      <label className="checkbox-row">
                        <input
                          type="checkbox"
                          checked={settings}
                          disabled={busy || !info.settings}
                          onChange={(event) =>
                            setSettings(event.target.checked)
                          }
                        />
                        Графика, звук и остальные настройки игры
                        {!info.settings && " — ещё не сохранены"}
                      </label>
                    </fieldset>
                  )}
                  {info && !info.controls && !info.settings && (
                    <p>
                      В этом профиле пока нет сохранённых настроек. Запустите
                      игру, настройте её и завершите обычным способом.
                    </p>
                  )}
                  <p>
                    Выбранные настройки заменят текущие. Перед заменой лаунчер
                    сохранит резервную копию. Миры, моды и исходный профиль
                    сохранятся.
                  </p>
                  {source &&
                    profileEngineLabel(source) !==
                      profileEngineLabel(profile) && (
                      <p className="muted">
                        Версии VoxelCore различаются. Часть настроек может не
                        поддерживаться в целевом профиле.
                      </p>
                    )}
                </>
              ) : (
                <p>
                  Будут возвращены настройки, сохранённые перед последним
                  импортом. Последующие изменения этих настроек в игре будут
                  заменены. Миры и моды сохранятся.
                </p>
              )}
              {error && (
                <ErrorNotice
                  retry={
                    mode === "import" && !info
                      ? () => setAttempt((n) => n + 1)
                      : undefined
                  }
                >
                  {error}
                </ErrorNotice>
              )}
              <div className="modal-actions">
                <button disabled={busy} onClick={() => setMode(null)}>
                  Отмена
                </button>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    (mode === "import" &&
                      (!source ||
                        running.has(source.id) ||
                        !info ||
                        loading ||
                        (!controls && !settings)))
                  }
                  onClick={() => void apply()}
                >
                  {busy
                    ? "Переносим…"
                    : mode === "restore"
                      ? "Восстановить настройки"
                      : "Импортировать настройки"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
