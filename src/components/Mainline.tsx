import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  formatBytes,
  mainBuildLabel,
  type MainBuild,
  type Runtime,
} from "../model";
import { ErrorNotice } from "./ui";
import { Select } from "./Select";

type Status = { enabled: boolean };
type Catalog = { head_sha: string; builds: MainBuild[] };
export function useMainlineStatus() {
  const [status, setStatus] = useState<Status>({ enabled: false });
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void invoke<Status>("mainline_status")
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    refresh();
    window.addEventListener("mainline-status", refresh);
    return () => {
      active = false;
      window.removeEventListener("mainline-status", refresh);
    };
  }, []);
  return { status, setStatus, error, setError };
}
export function MainlineSettings({
  busy,
  install,
  runtimes,
}: {
  busy: boolean;
  install: (build: MainBuild) => Promise<boolean>;
  runtimes: Runtime[];
}) {
  const { status, setStatus, error, setError } = useMainlineStatus();
  const [working, setWorking] = useState(false);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState(0);
  const [message, setMessage] = useState("");
  const [accepted, setAccepted] = useState(false);
  const announce = () => window.dispatchEvent(new Event("mainline-status"));
  const reload = async () => {
    setWorking(true);
    setError("");
    try {
      const data = await invoke<Catalog>("list_mainline_builds");
      setCatalog(data);
      setSelected(data.builds[0]?.artifact_id ?? 0);
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };
  const toggle = async (value: boolean) => {
    setWorking(true);
    setError("");
    try {
      setStatus(await invoke<Status>("set_mainline_enabled", { value }));
      setCatalog(null);
      setMessage("");
      setAccepted(false);
      announce();
    } catch (e) {
      setError(String(e));
      setStatus(await invoke<Status>("mainline_status"));
      announce();
    } finally {
      setWorking(false);
    }
  };
  const build = catalog?.builds.find((b) => b.artifact_id === selected);
  const installed =
    build &&
    runtimes.some((r) => r.main_build?.artifact_id === build.artifact_id);
  return (
    <section className="mainline-settings">
      <div className="setting-row mainline-enable-row">
        <div>
          <h2>Сборки VoxelCore из main</h2>
          <p>
            Здесь можно поставить свежую сборку из GitHub Actions. Архив
            скачивается через nightly.link без входа в GitHub.
          </p>
        </div>
        <label className="checkbox-row mainline-enable-control">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={busy || working}
            onChange={(e) => void toggle(e.target.checked)}
          />
          Включить
        </label>
      </div>
      {status.enabled && (
        <>
          <div className="notice mainline-warning">
            <div className="notice-copy">
              <strong>Используйте отдельный профиль</strong>
              <p>
                Сборки main могут содержать ошибки и быть несовместимы с модами
                и мирами. Перед запуском сделайте резервную копию мира.
              </p>
            </div>
          </div>

          <section className="mainline-card">
              <div className="section-heading mainline-card-heading">
                <div>
                  <h3>Доступные сборки</h3>
                  <p>
                    Последние успешные сборки официальной ветки main для этой
                    системы.
                  </p>
                </div>
                <button
                  disabled={busy || working}
                  onClick={() => void reload()}
                >
                  {working
                    ? "Обновляем…"
                    : catalog
                      ? "Обновить"
                      : "Загрузить список"}
                </button>
              </div>
              {!catalog && (
                <p className="muted">Загрузите список, чтобы выбрать сборку.</p>
              )}
              {catalog && !catalog.builds.length && (
                <p className="muted">
                  Нет доступных успешных сборок для этой системы.
                </p>
              )}
              {!!catalog?.builds.length && (
                <>
                  <label className="mainline-build-select">
                    Сборка для установки
                    <Select
                      value={selected}
                      disabled={busy || working}
                      onChange={(e) => {
                        setSelected(Number(e.target.value));
                        setAccepted(false);
                      }}
                    >
                      {catalog.builds.map((b) => (
                        <option key={b.artifact_id} value={b.artifact_id}>
                          {mainBuildLabel(b)} · #{b.artifact_id}
                        </option>
                      ))}
                    </Select>
                  </label>
                  {build && (
                    <div className="mainline-build-details">
                      <div className="mainline-build-meta">
                        <div>
                          <span>Статус</span>
                          <strong>
                            {build.sha === catalog.head_sha
                              ? "Последний коммит main"
                              : "Предыдущая успешная"}
                          </strong>
                        </div>
                        <div>
                          <span>Размер</span>
                          <strong>{formatBytes(build.size)}</strong>
                        </div>
                        <div>
                          <span>Доступна до</span>
                          <strong>{build.expires_at.slice(0, 10)}</strong>
                        </div>
                      </div>
                      {build.sha !== catalog.head_sha && (
                        <p className="muted">
                          Текущий main: {catalog.head_sha.slice(0, 7)}
                        </p>
                      )}
                      <label className="checkbox-row mainline-risk-confirmation">
                        <input
                          type="checkbox"
                          checked={accepted}
                          disabled={!!installed}
                          onChange={(e) => setAccepted(e.target.checked)}
                        />
                        Понимаю риск использования экспериментальной сборки
                      </label>
                      <div className="actions mainline-build-actions">
                        <button
                          disabled={busy}
                          onClick={() =>
                            void openUrl(
                              `https://github.com/MihailRis/voxelcore/commit/${build.sha}`,
                            ).catch((error) => setError(String(error)))
                          }
                        >
                          Посмотреть коммит
                        </button>
                        <button
                          className="primary"
                          disabled={busy || working || !accepted || !!installed}
                          onClick={() =>
                            void install(build).then((ok) => {
                              if (ok)
                                setMessage(
                                  "Сборка установлена. Теперь её можно выбрать при создании профиля или в разделе «Управление».",
                                );
                            })
                          }
                        >
                          {installed ? "Уже установлена" : "Установить сборку"}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
          </section>
        </>
      )}
      {!status.enabled && (
        <p className="muted mainline-disabled-note">
          Режим выключен. Уже установленные сборки и профили сохраняются.
        </p>
      )}
      {message && (
        <div className="notice success" role="status">
          {message}
        </div>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </section>
  );
}
