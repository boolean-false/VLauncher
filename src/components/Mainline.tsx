import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type MainBuild, type Runtime } from "../model";
import { ErrorNotice } from "./ui";
import { ExperimentalBuildPicker } from "./ExperimentalBuildPicker";

type Status = { enabled: boolean };
export function useMainlineStatus() {
  const [status, setStatus] = useState<Status>({ enabled: false });
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void invoke<Status>("mainline_status")
        .then((s) => {
          if (active) {
            setStatus(s);
            setError("");
          }
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
  const [build, setBuild] = useState<MainBuild | null>(null);
  return (
    <section className="mainline-settings">
      <div className="setting-row">
        <div>
          <h2>DEV-сборки VoxelCore</h2>
          <p>
            Новую версию можно попробовать в отдельном профиле. Нужный движок
            скачается автоматически.
          </p>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={status.enabled}
            disabled={busy || working}
            onChange={(event) => {
              setWorking(true);
              void invoke<Status>("set_mainline_enabled", {
                value: event.target.checked,
              })
                .then((value) => {
                  setStatus(value);
                  setError("");
                  window.dispatchEvent(new Event("mainline-status"));
                })
                .catch((reason) => setError(String(reason)))
                .finally(() => setWorking(false));
            }}
          />
          Показывать доступные сборки здесь
        </label>
      </div>
      {status.enabled && (
        <section className="mainline-card">
          <ExperimentalBuildPicker
            runtimes={runtimes}
            value={build}
            onChange={setBuild}
            busy={busy || working}
          />
          <p>
            DEV-сборки могут содержать ошибки и быть несовместимы с модами и
            мирами.
          </p>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || working || !build}
              onClick={() => build && void install(build)}
            >
              Создать профиль с этой версией
            </button>
          </div>
        </section>
      )}
      {error && <ErrorNotice>{error}</ErrorNotice>}
    </section>
  );
}
