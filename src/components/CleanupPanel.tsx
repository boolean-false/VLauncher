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
  package_id?: string | null;
  identifier: string;
  title: string;
  status: string;
  ever_published: boolean;
  has_dependencies: boolean;
  deleted_at: string;
};
type ReservationHistoryItem = {
  id: number;
  slug: string;
  identifier: string;
  title: string;
  status: string;
  ever_published: boolean;
  reason: string;
  created_at: string;
  released_by?: string | null;
};
type CleanupSummary = {
  total: number;
  safe: number;
  published: number;
  referenced: number;
  orphan_artifacts: number;
  expired_uploads: number;
  storage_queue: number;
  multipart_queue: number;
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
  const [reservationHistory, setReservationHistory] = useState<ReservationHistoryItem[]>([]);
  const [reservationQuery, setReservationQuery] = useState("");
  const [summary, setSummary] = useState<CleanupSummary | null>(null);
  const [page, setPage] = useState(0);
  const [more, setMore] = useState(false);
  const [status, setStatus] = useState("pending");
  const [mode, setMode] = useState("requests");
  const [refresh, setRefresh] = useState(0);
  const [action, setAction] = useState<{
    kind: string;
    slug: string;
    id?: number;
    published?: boolean;
  } | null>(null);
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState("");
  const [allowPublished, setAllowPublished] = useState(false);
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
        : mode === "reservations"
          ? req<{ items: Reservation[]; has_more: boolean; summary: CleanupSummary }>(
            `reservations?${new URLSearchParams({ offset: String(page * 50), q: reservationQuery })}`,
            { cache: "no-store" },
          ).then((d) => {
            if (live) {
              setReservations(d.items);
              setMore(d.has_more);
              setSummary(d.summary);
            }
          })
          : req<{ items: ReservationHistoryItem[]; has_more: boolean }>(
              `reservations/history?${new URLSearchParams({ offset: String(page * 50), q: reservationQuery })}`,
              { cache: "no-store" },
            ).then((d) => {
              if (live) {
                setReservationHistory(d.items);
                setMore(d.has_more);
              }
            })
    ).catch((e) => {
      if (live) setError(String(e));
    });
    return () => {
      live = false;
    };
  }, [token, page, status, mode, reservationQuery, refresh, revision]);
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
    setAllowPublished(false);
    setError("");
  };
  async function submit() {
    if (!action) return;
    await act(async () => {
      const result = await req<{ count?: number }>(
        action.kind === "delete"
          ? `targets/${kind}/${encodeURIComponent(action.slug)}`
          : action.kind === "release"
            ? `reservations/${encodeURIComponent(action.slug)}/release`
            : action.kind === "release-safe"
              ? "reservations/release-safe"
              : action.kind === "request"
                ? "requests"
                : `requests/${action.id}/review`,
        {
          method: action.kind === "delete" ? "DELETE" : "POST",
          body: JSON.stringify({
            reason,
            confirm_slug: confirm,
            kind,
            slug: action.slug,
            status: action.kind,
            allow_published: allowPublished,
          }),
        },
      );
      setAction(null);
      setTarget(null);
      setRefresh((n) => n + 1);
      setMessage(
        action.kind === "release-safe"
          ? `Освобождено безопасных идентификаторов: ${result.count ?? 0}. История сохранена.`
          : "Действие выполнено и записано в историю.",
      );
    });
  }
  return (
    <section className="team-settings">
      <h3>Очистка спама</h3>
      <p>
        Модератор отправляет заявку. Администратор удаляет с указанием причины.
        Пустой неопубликованный проект освобождает адрес автоматически.
        Опубликованный адрес сохраняется как защита старых ссылок, но владелец
        платформы может явно освободить его. Удаление команды сохраняет проекты
        у их владельцев.
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
            Удалённые адреса
          </button>
        )}
        <button
          className={mode === "history" ? "active" : ""}
          onClick={() => {
            setMode("history");
            setPage(0);
          }}
        >
          История адресов
        </button>
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
      ) : mode === "reservations" ? (
        <>
          <p>
            Здесь остаются опубликованные адреса и старые записи, созданные до
            автоматического освобождения черновиков. История удаления хранится
            отдельно и не пропадает после освобождения адреса.
          </p>
          {summary && (
            <div className="cleanup-summary">
              <div><strong>{summary.total}</strong><span>удалённых адресов</span></div>
              <div><strong>{summary.safe}</strong><span>можно освободить безопасно</span></div>
              <div><strong>{summary.published}</strong><span>ранее публиковались</span></div>
              <div><strong>{summary.referenced}</strong><span>используются зависимостями</span></div>
              <div><strong>{summary.orphan_artifacts}</strong><span>артефактов без ссылок</span></div>
              <div><strong>{summary.expired_uploads}</strong><span>просроченных загрузок</span></div>
              <div><strong>{summary.storage_queue + summary.multipart_queue}</strong><span>объектов в очереди удаления</span></div>
            </div>
          )}
          <div className="actions">
            <label>
              Поиск по адресу или названию
              <input
                type="search"
                value={reservationQuery}
                onChange={(event) => {
                  setReservationQuery(event.target.value);
                  setPage(0);
                }}
              />
            </label>
            <button
              disabled={busy || !summary?.safe}
              onClick={() => begin({ kind: "release-safe", slug: "" })}
            >
              Освободить все безопасные…
            </button>
          </div>
          {!reservations.length && <p>Резервирований нет.</p>}
          {reservations.map((r) => (
            <article className="form-card" key={r.slug}>
              <h3>
                {r.title} · {r.identifier}
              </h3>
              <p>
                {r.has_dependencies
                  ? "Используется в зависимостях — освобождение заблокировано"
                  : r.ever_published
                    ? "Ранее публиковался — освобождение может перенаправить старые ссылки"
                    : "Можно освободить без риска для публикаций"}
              </p>
              {r.identifier !== r.slug && <small>Внутренняя запись: {r.slug}</small>}
              <small>Удалён {new Date(r.deleted_at).toLocaleString("ru")} · {r.status}</small>
              <button
                disabled={busy || r.has_dependencies}
                onClick={() => begin({ kind: "release", slug: r.identifier, published: r.ever_published })}
              >
                {r.ever_published ? "Освободить опубликованный адрес…" : "Освободить адрес…"}
              </button>
            </article>
          ))}
        </>
      ) : (
        <>
          <p>
            Здесь видны уже освобождённые адреса. Они больше не блокируют новые
            проекты, но запись об удалении и причина сохраняются для проверки.
          </p>
          <label>
            Поиск по адресу или названию
            <input
              type="search"
              value={reservationQuery}
              onChange={(event) => {
                setReservationQuery(event.target.value);
                setPage(0);
              }}
            />
          </label>
          {!reservationHistory.length && <p>История пуста.</p>}
          {reservationHistory.map((item) => (
            <article className="form-card" key={item.id}>
              <h3>{item.title} · {item.identifier}</h3>
              <p>{item.reason}</p>
              {item.identifier !== item.slug && <small>Внутренняя запись: {item.slug}</small>}
              <small>
                Освобождён {new Date(item.created_at).toLocaleString("ru")}
                {item.released_by ? ` · @${item.released_by}` : " · автоматически"}
                {item.ever_published ? " · ранее публиковался" : " · не публиковался"}
              </small>
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
                : action.kind === "release-safe"
                  ? "Освободить безопасные адреса?"
                  : "Решение по очистке"
          }
          busy={busy}
          close={() => setAction(null)}
          closeOnBackdrop={false}
        >
          <p>
            {action.kind === "release"
              ? "Другой автор сможет занять этот адрес. Запись об удалении останется в истории."
              : action.kind === "release-safe"
                ? `Будут освобождены ${summary?.safe ?? 0} никогда не публиковавшихся адресов без зависимостей. История удаления останется.`
                : action.kind === "delete"
                  ? "Объект будет удалён без возможности восстановления. История действий сохранится."
                  : "Укажите причину или результат проверки."}
          </p>
          {action.kind === "release" && action.published && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={allowPublished}
                disabled={busy}
                onChange={(event) => setAllowPublished(event.target.checked)}
              />
              Понимаю: старые ссылки смогут открыть другой проект с этим адресом
            </label>
          )}
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
                (action.kind === "release" && action.published && !allowPublished) ||
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
