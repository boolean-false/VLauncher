import { useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { gameFailureLines, gameFailureReport } from "../gameDiagnostics";
import { friendlyError, type GameEvent } from "../model";
import { Modal } from "./ui";

export function GameFailureDetails({
  profileName,
  engine,
  event,
  logs,
  close,
  openLog,
}: {
  profileName: string;
  engine: string;
  event: GameEvent;
  logs: GameEvent[];
  close: () => void;
  openLog: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const lines = gameFailureLines(event, logs);
  return (
    <Modal title={`Игра завершилась с ошибкой · ${profileName}`} close={close}>
      <p>
        {event.duration_ms != null && event.duration_ms < 10_000
          ? "VoxelCore закрылся вскоре после запуска."
          : "VoxelCore завершился с ошибкой во время работы."}{" "}
        Последние строки лога могут помочь найти причину.
      </p>
      <dl className="game-failure-status">
        <dt>Завершение</dt>
        <dd>{event.message}</dd>
        {event.exit_code != null && (
          <>
            <dt>Код завершения</dt>
            <dd>{event.exit_code}</dd>
          </>
        )}
        {event.signal != null && (
          <>
            <dt>Сигнал</dt>
            <dd>{event.signal}</dd>
          </>
        )}
        {event.duration_ms != null && (
          <>
            <dt>Время работы</dt>
            <dd>{(event.duration_ms / 1000).toFixed(1)} с</dd>
          </>
        )}
      </dl>
      <h3>Последние строки лога</h3>
      {lines.length ? (
        <pre className="game-failure-output selectable">
          {lines.map((line) => `[${line.stream}] ${line.message}`).join("\n")}
        </pre>
      ) : (
        <p className="muted">
          Вывод игры недоступен. Скопируйте подробности завершения для
          диагностики.
        </p>
      )}
      {error && <p className="notice error">{error}</p>}
      <div className="modal-actions">
        <button onClick={close}>Закрыть</button>
        <button onClick={openLog}>Открыть лог</button>
        <button
          className="primary"
          onClick={() => {
            setError("");
            void writeText(gameFailureReport(profileName, engine, event, logs))
              .then(() => setCopied(true))
              .catch((error) => setError(friendlyError(error)));
          }}
        >
          {copied ? "Скопировано" : "Скопировать подробности"}
        </button>
      </div>
    </Modal>
  );
}
