import { useEffect, useState } from "react";
import { registryRequest } from "../api";
import { Modal } from "./ui";
type Item = {
  id: number;
  kind: string;
  slug: string;
  reason: string;
  requester: string;
  status: string;
  resolution: string;
};
type Reservation = {
  slug: string;
  title: string;
  status: string;
  ever_published: boolean;
  has_dependencies: boolean;
  deleted_at: string;
};
type Target = {
  slug: string;
  title?: string;
  name?: string;
  releases?: number;
  active_uploads?: number;
  dependent_projects?: number;
  members?: { username: string }[];
  projects?: { slug: string; title: string; owner: string }[];
};
export function CleanupPanel({
  token,
  role,
  revision,
}: {
  token: string;
  role: string;
  revision: number;
}) {
  const [kind, setKind] = useState("project");
  const [slug, setSlug] = useState("");
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [status, setStatus] = useState("pending");
  const [mode, setMode] = useState("requests");
  const [refresh, setRefresh] = useState(0);
  const [action, setAction] = useState<{
    kind: string;
    slug: string;
    id?: number;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const manager = role === "owner" || role === "admin";
  const req = <T,>(path: string, init?: RequestInit) =>
    registryRequest<T>(`/management/cleanup/${path}`, init, token);
  useEffect(() => {
    let live = true;
    setError("");
    void (
      mode === "requests"
        ? req<{ items: Item[]; has_more: boolean }>(
            `requests?offset=${page * 50}&status=${status}`,
            { cache: "no-store" },
          ).then((d) => {
            if (live) {
              setItems(d.items);
              setMore(d.has_more);
            }
          })
        : req<{ items: Reservation[]; has_more: boolean }>(
            `reservations?offset=${page * 50}`,
            { cache: "no-store" },
          ).then((d) => {
            if (live) {
              setReservations(d.items);
              setMore(d.has_more);
            }
          })
    ).catch((e) => {
      if (live) setError(String(e));
    });
    return () => {
      live = false;
    };
  }, [token, page, status, mode, refresh, revision]);
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const begin = (value: NonNullable<typeof action>) => {
    setAction(value);
    setReason("");
    setConfirm("");
    setError("");
  };
  async function submit() {
    if (!action) return;
    await act(async () => {
      const body = JSON.stringify({
        reason,
        confirm_slug: confirm,
        kind,
        slug: action.slug,
        status: action.kind,
      });
      await req(
        action.kind === "delete"
          ? `targets/${kind}/${encodeURIComponent(action.slug)}`
          : action.kind === "release"
            ? `reservations/${encodeURIComponent(action.slug)}/release`
            : action.kind === "request"
              ? "requests"
              : `requests/${action.id}/review`,
        { method: action.kind === "delete" ? "DELETE" : "POST", body },
      );
      setAction(null);
      setTarget(null);
      setRefresh((n) => n + 1);
      setMessage("Действие выполнено и записано в историю.");
    });
  }
  return (
    <section className="team-settings">
      <h3>Очистка спама</h3>
      <p>
        Модератор отправляет заявку. Администратор удаляет с указанием причины.
        Удаление проекта сохраняет резервирование имени и историю; удаление
        команды сохраняет проекты у их владельцев.
      </p>
      {error && !action && (
        <p role="alert" className="error-notice">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setTarget(null);
          void act(async () =>
            setTarget(
              await req<Target>(`targets/${kind}/${encodeURIComponent(slug)}`, {
                cache: "no-store",
              }),
            ),
          );
        }}
      >
        <label>
          Объект
          <select
            value={kind}
            disabled={busy}
            onChange={(e) => {
              setKind(e.target.value);
              setTarget(null);
            }}
          >
            <option value="project">Проект</option>
            <option value="team">Команда</option>
          </select>
        </label>
        <label>
          Идентификатор
          <input
            value={slug}
            disabled={busy}
            required
            onChange={(e) => {
              setSlug(e.target.value);
              setTarget(null);
            }}
          />
        </label>
        <button disabled={busy}>Проверить перед удалением</button>
      </form>
      {target && (
        <div className="form-card">
          <h3>
            {target.title || target.name} · {target.slug}
          </h3>
          {kind === "project" ? (
            <p>
              Версий: {target.releases}. Зависимых опубликованных проектов:{" "}
              {target.dependent_projects}. Активных загрузок:{" "}
              {target.active_uploads}. После удаления новые установки могут
              стать недоступны.
            </p>
          ) : (
            <>
              <p>
                Участников: {target.members?.length}. Проекты будут отсоединены:
              </p>
              {target.projects?.map((p) => (
                <p key={p.slug}>
                  {p.title} · {p.slug} · @{p.owner}
                </p>
              ))}
            </>
          )}
          <button
            className="danger"
            disabled={busy || (manager && !!target.active_uploads)}
            onClick={() =>
              begin({ kind: manager ? "delete" : "request", slug: target.slug })
            }
          >
            {manager ? "Удалить…" : "Запросить очистку…"}
          </button>
        </div>
      )}
      <nav className="workshop-project-tabs" aria-label="Очередь очистки">
        <button
          className={mode === "requests" ? "active" : ""}
          onClick={() => {
            setMode("requests");
            setPage(0);
          }}
        >
          Заявки
        </button>
        {role === "owner" && (
          <button
            className={mode === "reservations" ? "active" : ""}
            onClick={() => {
              setMode("reservations");
              setPage(0);
            }}
          >
            Зарезервированные имена
          </button>
        )}
        <button disabled={busy} onClick={() => setRefresh((n) => n + 1)}>
          Обновить
        </button>
      </nav>
      {mode === "requests" ? (
        <>
          <label>
            Состояние
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
            >
              <option value="pending">Ожидают решения</option>
              <option value="resolved">Выполнены</option>
              <option value="dismissed">Отклонены</option>
            </select>
          </label>
          {!items.length && <p>Заявок нет.</p>}
          {items.map((i) => (
            <article className="form-card" key={i.id}>
              <h3>
                {i.kind === "project" ? "Проект" : "Команда"} · {i.slug}
              </h3>
              <p>
                @{i.requester}: {i.reason}
              </p>
              {i.resolution && <p>{i.resolution}</p>}
              {manager && i.status === "pending" && (
                <div className="modal-actions">
                  <button
                    onClick={() => {
                      setKind(i.kind);
                      setSlug(i.slug);
                      setTarget(null);
                    }}
                  >
                    Подставить для проверки
                  </button>
                  <button
                    onClick={() =>
                      begin({ kind: "resolved", slug: i.slug, id: i.id })
                    }
                  >
                    Отметить выполненной…
                  </button>
                  <button
                    onClick={() =>
                      begin({ kind: "dismissed", slug: i.slug, id: i.id })
                    }
                  >
                    Отклонить…
                  </button>
                </div>
              )}
            </article>
          ))}
        </>
      ) : (
        <>
          <p>
            Освобождаются только имена никогда не опубликованных проектов без
            зависимостей. История нарушений и блокировки сохраняется.
          </p>
          {!reservations.length && <p>Резервирований нет.</p>}
          {reservations.map((r) => (
            <article className="form-card" key={r.slug}>
              <h3>
                {r.title} · {r.slug}
              </h3>
              <p>
                {r.ever_published
                  ? "Была публикация или её отсутствие нельзя подтвердить"
                  : r.has_dependencies
                    ? "Имя используется в зависимостях"
                    : "Можно освободить"}{" "}
                · {r.status}
              </p>
              <button
                disabled={busy || r.ever_published || r.has_dependencies}
                onClick={() => begin({ kind: "release", slug: r.slug })}
              >
                Освободить имя…
              </button>
            </article>
          ))}
        </>
      )}
      <div className="modal-actions">
        <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
          Назад
        </button>
        <span>Страница {page + 1}</span>
        <button disabled={!more} onClick={() => setPage((p) => p + 1)}>
          Далее
        </button>
      </div>
      {action && (
        <Modal
          title={
            action.kind === "delete"
              ? `Удалить ${action.slug}?`
              : action.kind === "release"
                ? `Освободить ${action.slug}?`
                : "Решение по очистке"
          }
          busy={busy}
          close={() => setAction(null)}
          closeOnBackdrop={false}
        >
          <p>
            {action.kind === "release"
              ? "Другой автор сможет создать проект с этим именем. Запись об удалении останется в истории."
              : action.kind === "delete"
                ? "Объект будет удалён без возможности восстановления. История действий сохранится."
                : "Укажите причину или результат проверки."}
          </p>
          {error && (
            <p role="alert" className="error-notice">
              {error}
            </p>
          )}
          <label>
            Причина
            <textarea
              value={reason}
              disabled={busy}
              minLength={3}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          {["delete", "release"].includes(action.kind) && (
            <label>
              Введите {action.slug}
              <input
                value={confirm}
                disabled={busy}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          )}
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setAction(null)}>
              Отмена
            </button>
            <button
              className="danger"
              disabled={
                busy ||
                reason.trim().length < 3 ||
                (["delete", "release"].includes(action.kind) &&
                  confirm !== action.slug)
              }
              onClick={() => void submit()}
            >
              {busy ? "Сохраняем…" : "Подтвердить"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
