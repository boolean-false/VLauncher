import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { friendlyError, type RunTask } from "../model";
import { checkForAppUpdate, type AppUpdateChannel } from "../appUpdates";

export function AppUpdates({
  channel,
  running,
  busy,
  run,
}: {
  channel: AppUpdateChannel;
  running: boolean;
  busy: boolean;
  run: RunTask;
}) {
  const [update, setUpdate] = useState<Update | null>(null);
  const [ready, setReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const blocked = useRef(running || busy);
  blocked.current = running || busy;

  useEffect(() => {
    if (import.meta.env.DEV) return;
    let stopped = false;
    let offered: Update | null = null;
    let checking = false;
    const poll = async () => {
      if (checking || offered) return;
      checking = true;
      try {
        const candidate = await checkForAppUpdate(channel);
        if (stopped) {
          await candidate?.close();
        } else if (candidate) {
          offered = candidate;
          setUpdate(candidate);
        }
      } catch {
        // Фоновая проверка не показывает ошибку сети.
      } finally {
        checking = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 4 * 60 * 60 * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
      void offered?.close().catch(() => {});
    };
  }, [channel]);

  const accept = async () => {
    if (!update) return;
    setWorking(true);
    setMessage("");
    try {
      if (!ready) {
        let received = 0;
        let total = 0;
        await update.download((event) => {
          if (event.event === "Started") total = event.data.contentLength ?? 0;
          if (event.event === "Progress") received += event.data.chunkLength;
          setMessage(
            total
              ? `Загрузка обновления: ${Math.min(100, Math.round((received / total) * 100))}%`
              : "Загружаем обновление…",
          );
        });
        setReady(true);
        setMessage("");
      } else if (!blocked.current) {
        const installed = await run("Обновление VLauncher", async (stage) => {
          stage("Устанавливаем обновление…");
          await update.install();
          await relaunch();
        });
        if (!installed)
          setMessage(
            "Не удалось завершить обновление. Подробности - в журнале.",
          );
      }
    } catch (error) {
      setMessage(friendlyError(error));
    } finally {
      setWorking(false);
    }
  };

  if (!update) return null;
  return (
    <aside
      className="notice update-notice"
      aria-label="Обновление VLauncher"
      aria-live="polite"
    >
      <div>
        <strong>VLauncher {update.version}</strong>
        <p role="status">
          {message ||
            (ready
              ? "Обновление загружено. Можно перезапустить приложение."
              : "Доступна новая версия приложения.")}
        </p>
        {update.body && (
          <details>
            <summary>Что нового</summary>
            <p style={{ whiteSpace: "pre-wrap" }}>{update.body}</p>
          </details>
        )}
        {ready && (running || busy) && (
          <small>Завершите игру и текущие операции перед установкой.</small>
        )}
      </div>
      <button
        disabled={working || (ready && (running || busy))}
        onClick={() => void accept()}
      >
        {working
          ? "Подождите…"
          : ready
            ? "Перезапустить и обновить"
            : "Скачать обновление"}
      </button>
    </aside>
  );
}
