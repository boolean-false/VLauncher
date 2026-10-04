import { useEffect, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { friendlyError, type RunTask } from "../model";
import { checkForAppUpdate, type AppUpdateChannel } from "../appUpdates";
import { retryDownload } from "../downloadRetry";

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
  const [details, setDetails] = useState("");
  const downloadControl = useRef<AbortController | null>(null);
  useEffect(() => () => downloadControl.current?.abort(), []);
  const blocked = useRef(running || busy);
  blocked.current = running || busy;

  useEffect(() => {
    if (import.meta.env.DEV) return;
    downloadControl.current?.abort();
    setUpdate(null);
    setReady(false);
    setMessage("");
    setDetails("");
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
      downloadControl.current?.abort();
      clearInterval(timer);
      void offered?.close().catch(() => {});
    };
  }, [channel]);

  const accept = async () => {
    if (!update) return;
    setWorking(true);
    setMessage("");
    setDetails("");
    try {
      if (!ready) {
        const control = new AbortController();
        downloadControl.current = control;
        let received = 0;
        let total = 0;
        await retryDownload(
          () => {
            received = 0;
            total = 0;
            return update.download((event) => {
              if (control.signal.aborted) return;
              if (event.event === "Started")
                total = event.data.contentLength ?? 0;
              if (event.event === "Progress")
                received += event.data.chunkLength;
              setMessage(
                total
                  ? `Загрузка обновления: ${Math.min(100, Math.round((received / total) * 100))}%`
                  : "Загружаем обновление…",
              );
            });
          },
          control.signal,
          (attempt, delay) =>
            setMessage(
              `Соединение прервано. Повторяем загрузку через ${delay / 1000} с · попытка ${attempt} из 3.`,
            ),
        );
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
      setMessage(
        downloadControl.current?.signal.aborted
          ? "Обновление отменено."
          : friendlyError(error),
      );
      if (!downloadControl.current?.signal.aborted) setDetails(String(error));
    } finally {
      downloadControl.current = null;
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
        {details && details !== message && (
          <details>
            <summary>Технические подробности</summary>
            <pre>{details}</pre>
          </details>
        )}
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
      {working && !ready && (
        <button
          onClick={() => {
            downloadControl.current?.abort();
            setMessage(
              "Отменяем обновление… Ожидаем завершения текущего запроса.",
            );
          }}
        >
          Отменить
        </button>
      )}
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
