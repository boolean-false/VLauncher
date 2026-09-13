import { useEffect, useState } from "react";
import { Modal } from "./ui";

type Action = "archive" | "restore" | "delete";
type Impact = {
  releases: number;
  dependent_projects: number;
  active_uploads: number;
};
export function ProjectLifecycleActions({
  project,
  request,
  changed,
  disabled = false,
}: {
  project: {
    slug: string;
    title: string;
    archived_at?: string | null;
    can_manage_lifecycle?: boolean;
  };
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  changed: (action: Action) => void;
  disabled?: boolean;
}) {
  const [action, setAction] = useState<Action | null>(null);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const path = `/creator/projects/${encodeURIComponent(project.slug)}`;
  // Иначе новый callback родителя повторяет запрос.
  useEffect(() => {
    if (action !== "delete") return;
    let alive = true;
    setImpact(null);
    setError("");
    void request<Impact>(`${path}/lifecycle`, { cache: "no-store" })
      .then((result) => {
        if (alive) setImpact(result);
      })
      .catch((reason) => {
        if (alive) setError(String(reason));
      });
    return () => {
      alive = false;
    };
  }, [path, action, retry]);
  if (project.can_manage_lifecycle === undefined)
    return <p>Сведения о правах проекта недоступны. Обновите данные мастерской. Если сообщение останется, серверу требуется обновление.</p>;
  if (!project.can_manage_lifecycle)
    return <p>Архивировать и удалить проект может только его владелец.</p>;
  const begin = (next: Action) => {
    setConfirmation("");
    setError("");
    setImpact(null);
    setAction(next);
  };
  const run = async () => {
    if (!action || busy) return;
    setBusy(true);
    setError("");
    try {
      await request(
        action === "delete" ? path : `${path}/${action}`,
        action === "delete"
          ? {
              method: "DELETE",
              body: JSON.stringify({ confirm_slug: confirmation }),
            }
          : { method: "POST" },
      );
      changed(action);
      setAction(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="project-lifecycle">
      <div>
        <h3>{project.archived_at ? "Проект в архиве" : "Архив проекта"}</h3>
        <p>
          Архив скрывает проект из каталога и основного списка ваших проектов.
          Опубликованные версии остаются доступны по ссылкам и для зависимостей.
          Статус модерации сохраняется.
        </p>
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => begin(project.archived_at ? "restore" : "archive")}
        >
          {project.archived_at ? "Вернуть из архива" : "Архивировать проект"}
        </button>
      </div>
      <div>
        <h3>Удаление проекта</h3>
        <p>
          Удаляет карточку, версии и изображения с платформы. Файлы на
          компьютерах игроков останутся. Восстановить проект нельзя.
        </p>
        <button
          type="button"
          className="danger"
          disabled={disabled || busy}
          onClick={() => begin("delete")}
        >
          Удалить проект…
        </button>
      </div>
      {action && (
        <Modal
          title={
            action === "delete"
              ? `Удалить «${project.title}»?`
              : action === "archive"
                ? "Архивировать проект?"
                : "Вернуть проект из архива?"
          }
          busy={busy}
          closeOnBackdrop={false}
          close={() => setAction(null)}
        >
          {action === "delete" ? (
            <div className="project-lifecycle-confirm">
              <p>
                Карточка, версии и картинки будут удалены. Проекты, которым
                нужен этот пакет, могут перестать устанавливаться. Уже
                установленные файлы останутся у игроков.
              </p>
              <p>
                Адрес <strong>{project.slug}</strong> нельзя будет занять снова.
                Запись об удалении останется у модераторов.
              </p>
              {!impact && !error && (
                <p role="status">Проверяем версии и зависимости…</p>
              )}
              {impact && (
                <>
                  <p>
                    Версий: {impact.releases}. Других опубликованных проектов с
                    зависимостью: {impact.dependent_projects}.
                  </p>
                  {impact.dependent_projects > 0 && (
                    <p className="notice warning">
                      Удаление может нарушить установку этих проектов.
                      Архивирование сохраняет доступ к опубликованным версиям.
                    </p>
                  )}
                  {impact.active_uploads > 0 && (
                    <p className="notice warning">
                      Сейчас загружается версия. Дождитесь конца или отмените
                      загрузку.
                    </p>
                  )}
                  <label>
                    Для подтверждения введите {project.slug}
                    <input
                      value={confirmation}
                      disabled={busy || !!impact.active_uploads}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          ) : (
            <p>
              {action === "archive"
                ? "Проект переместится в архив. Его можно будет вернуть, а опубликованные версии продолжат работать."
                : "Проект вернётся в основной список. Его статус модерации не изменится."}
            </p>
          )}
          {error && (
            <p className="error-notice" role="alert">
              {error}
            </p>
          )}
          {action === "delete" && (!!error || !!impact?.active_uploads) && (
            <button disabled={busy} onClick={() => setRetry((n) => n + 1)}>
              Повторить проверку
            </button>
          )}
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setAction(null)}>
              Отмена
            </button>
            <button
              className={action === "delete" ? "danger" : "primary"}
              disabled={
                busy ||
                (action === "delete" &&
                  (!impact ||
                    !!impact.active_uploads ||
                    confirmation !== project.slug))
              }
              onClick={() => void run()}
            >
              {busy
                ? "Сохраняем…"
                : action === "delete"
                  ? "Удалить безвозвратно"
                  : action === "archive"
                    ? "Архивировать"
                    : "Вернуть из архива"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
