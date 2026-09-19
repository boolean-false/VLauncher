import { registryMediaUrl } from "../mediaUrl";
import { useCallback, useEffect, useRef, useState } from "react";
import { registryRequest, registryUrl } from "../api";
import { formatBytes } from "../model";
import { Modal, ErrorNotice } from "./ui";
import { Select } from "./Select";
import { Markdown } from "./Markdown";
import { ManifestContentLinks } from "./ManifestContentLinks";
import { PrivateImage } from "./PrivateImage";
import { CategoryPicker } from "./CategoryPicker";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

type Section =
  | "projects"
  | "queue"
  | "users"
  | "reports"
  | "history"
  | "organizations"
  | "uploads";
type Media = { id: string; kind: string };
type Item = {
  id: string;
  slug?: string;
  title?: string;
  username?: string;
  author?: string;
  role?: string;
  status?: string;
  blocked?: boolean;
  block_reason?: string;
  storage_limit?: number | null;
  used_bytes?: number;
  kind?: string;
  summary?: string;
  description?: string;
  license?: string;
  categories?: string[];
  media?: Media[];
  version?: string;
  target?: string;
  architecture?: string;
  changelog?: string;
  manifest?: unknown;
  artifact_size?: number;
  project_slug?: string;
  reporter?: string;
  reason?: string;
  details?: string;
  resolution?: string;
  reviewer?: string;
  action?: string;
  created_at?: string;
  error?: string;
  expected_size?: number;
  name?: string;
  members?: { username: string; role: string }[];
};
type Revision = {
  id: number;
  created_at: string;
  snapshot: {
    title: string;
    summary: string;
    description: string;
    license: string | null;
    categories: string[];
    status: string;
    media?: Media[];
  };
};
type Action = {
  title: string;
  path: string;
  method?: string;
  fields?: Record<string, unknown>;
  note?: string;
};
const labels: Record<string, string> = {
  author_archive: "Проект архивирован автором",
  author_restore: "Проект возвращён из архива",
  author_delete: "Проект удалён автором",
  staff_delete: "Проект удалён администратором",
  team_delete: "Команда удалена владельцем",
  staff_team_delete: "Команда удалена администратором",
  team_leave: "Участник покинул команду",
  team_transfer: "Передано владение командой",
  team_member: "Изменён участник команды",
  team_member_remove: "Участник исключён из команды",
  cleanup_requested: "Запрошена очистка",
  cleanup_resolved: "Очистка выполнена",
  cleanup_dismissed: "Заявка на очистку отклонена",
  reservation_release: "Освобождён идентификатор проекта",
  owner: "Владелец",
  admin: "Администратор",
  moderator: "Модератор",
  user: "Автор",
  published: "Опубликован",
  review: "На проверке",
  pending_review: "На проверке",
  draft: "Черновик",
  blocked: "Заблокирован",
  archived: "Архив",
  retired: "Архив",
  withdrawn: "Отозван",
  yanked: "Снят",
  rejected: "Отклонён",
  open: "Открыта",
  resolved: "Закрыта",
  processing: "Обработка",
  queued: "В очереди",
  approved: "Одобрение",
  role: "Смена роли",
  report_resolve: "Решение по жалобе",
  report_reopen: "Жалоба открыта повторно",
  release_withdraw: "Версия снята",
  release_reopen: "Версия отправлена на пересмотр",
  launcher_withdraw: "Обновление отозвано",
  launcher_notes: "Описание выпуска изменено",
  launcher_publish: "Выпуск опубликован",
  launcher_draft_delete: "Черновик удалён",
  account_block: "Аккаунт заблокирован",
  account_unblock: "Аккаунт разблокирован",
  sessions_revoked: "Сессии отозваны",
  storage_quota: "Квота изменена",
  project_edit: "Карточка исправлена",
  project_transfer: "Проект передан",
  revision_restore: "Редакция восстановлена",
  media_remove: "Изображение удалено",
  owner_provision: "Владелец назначен",
  organization_member: "Участник команды изменён",
  organization_transfer: "Команда передана",
  category: "Категория изменена",
  category_delete: "Категория удалена",
  moderation_settings: "Настройки модерации",
  auto_approved: "Автоматическое одобрение",
};
const text = (value?: string) => (value ? (labels[value] ?? value) : "");
const filters: Partial<Record<Section, string[]>> = {
  projects: ["review", "published", "draft", "blocked", "archived"],
  users: ["owner", "admin", "moderator", "user"],
  reports: ["open", "resolved"],
  uploads: [
    "uploading",
    "queued",
    "processing",
    "completed",
    "rejected",
    "cancelled",
  ],
};

export function ManagementPanel({
  section,
  token,
  role,
  username,
  revision,
  initialState = "",
}: {
  section: Section;
  token: string;
  role: string;
  username: string;
  revision: number;
  initialState?: string;
}) {
  const manager = ["owner", "admin"].includes(role);
  const [q, setQ] = useState("");
  const [state, setState] = useState(
    initialState || (section === "reports" ? "open" : ""),
  );
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<{
    items: Item[];
    total: number;
    default_storage_limit?: number;
  }>({ items: [], total: 0 });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [deletedRecord, setDeletedRecord] = useState<{
    previous_deletions?: { id: number; record: unknown; reason: string; created_at: string }[];
    slug: string; package_id?: string | null; title: string; status: string; deleted_at: string;
    snapshot: { releases: { id: string; version: string; status: string; review?: string }[];
      reports: { id: string; reason: string; details: string; status: string; resolution?: string }[] };
  } | null>(null);
  const [selected, setSelected] = useState<Item | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [actionError, setActionError] = useState("");
  const [downloadStatus, setDownloadStatus] = useState("");
  const downloading = useRef(false);
  const lock = useRef(false);
  const request = useCallback(
    <T,>(path: string, init?: RequestInit) =>
      registryRequest<T>(path, init, token),
    [token],
  );
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const timer = setTimeout(() => {
      void request<typeof page>(
        `/management/${section}?${new URLSearchParams({ q, state, offset: String(offset) })}`,
      )
        .then((value) => {
          if (alive) {
            setPage(value);
            setError("");
          }
        })
        .catch((e) => {
          if (alive) setError(String(e));
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [request, section, q, state, offset, revision, refresh]);
  const propose = (value: Action) => {
    setAction(value);
    setReason("");
    setActionError("");
  };
  const perform = async () => {
    if (!action || lock.current) return;
    lock.current = true;
    setBusy(true);
    setActionError("");
    try {
      await request(action.path, {
        method: action.method ?? "POST",
        body: JSON.stringify({
          ...action.fields,
          reason,
          ...(section === "reports" && action.path.endsWith("/resolve")
            ? { resolution: reason }
            : {}),
        }),
      });
      setAction(null);
      setSelected(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      setActionError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const download = async (kind: string, id: string, filename: string) => {
    if (downloading.current) return;
    downloading.current = true;
    setError("");
    try {
      const path = await save({ defaultPath: filename });
      if (!path) return;
      setDownloadStatus(`Скачиваем ${filename}…`);
      await invoke("download_review_file", { kind, id, path, token });
      setDownloadStatus(`Файл сохранён: ${path}`);
    } catch (e) {
      setDownloadStatus("");
      setError(String(e));
    } finally {
      downloading.current = false;
    }
  };
  return (
    <section className="management-panel">
      <div className="management-filters">
        <label>
          Поиск
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
            placeholder={
              section === "history"
                ? "Объект, сотрудник, причина или дата"
                : "Название или имя"
            }
          />
        </label>
        {filters[section] && (
          <label>
            Фильтр
            <Select
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setOffset(0);
              }}
            >
              <option value="">Все</option>
              {filters[section]!.map((value) => (
                <option key={value} value={value}>
                  {text(value)}
                </option>
              ))}
            </Select>
          </label>
        )}
        {section === "history" && (
          <label>
            Тип действия
            <input
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setOffset(0);
              }}
              placeholder="Например: role"
            />
          </label>
        )}
      </div>
      {error && (
        <ErrorNotice>
          {error}
          <button onClick={() => setRefresh((n) => n + 1)}>Повторить</button>
        </ErrorNotice>
      )}
      {downloadStatus && <p role="status">{downloadStatus}</p>}
      {loading && <p role="status">Загрузка…</p>}
      {!loading && !page.items.length && (
        <p>По этим условиям ничего не найдено.</p>
      )}
      <fieldset
        className="review-list management-records"
        disabled={loading || busy}
        aria-busy={loading}
      >
        {page.items.map((item) => (
          <article className="review-card" key={item.id}>
            <div className="section-heading">
              <div>
                <h3>
                  {item.title ||
                    item.name ||
                    item.username ||
                    item.project_slug ||
                    item.slug ||
                    item.target ||
                    "Запись"}
                </h3>
                <p>
                  {[
                    item.slug,
                    item.author && `@${item.author}`,
                    text(item.status),
                    text(item.role),
                    item.version,
                    item.target,
                    item.architecture,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              {[
                "projects",
                "users",
                "organizations",
                ...(item.status === "draft" ? ["launcher"] : []),
              ].includes(section) && (
                <button disabled={loading} onClick={() => setSelected(item)}>
                  Управление
                </button>
              )}
            </div>
            {section === "users" && (
              <p>
                {item.blocked
                  ? `Заблокирован: ${item.block_reason}`
                  : "Аккаунт активен"}{" "}
                · Занято {formatBytes(item.used_bytes ?? 0)} /{" "}
                {formatBytes(
                  item.storage_limit ?? page.default_storage_limit ?? 0,
                )}
              </p>
            )}
            {section === "history" && (
              <>
                <strong>{text(item.action)}</strong>
                <p>{item.reason}</p>
                {["author_delete", "staff_delete", "reservation_release"].includes(item.action || "") && <button disabled={busy} onClick={() => void (async () => {
                  setBusy(true); setError("");
                  try { setDeletedRecord(await registryRequest(`/management/deleted-projects/${encodeURIComponent(item.target || "")}`, undefined, token)); }
                  catch (reason) { setError(String(reason)); }
                  finally { setBusy(false); }
                })()}>Запись об удалении</button>}
                <small>
                  {item.created_at &&
                    new Date(item.created_at).toLocaleString("ru")}
                </small>
              </>
            )}
            {section === "reports" && (
              <>
                <p>
                  @{item.reporter} · {item.reason}
                </p>
                <p>{item.details}</p>
                {item.resolution && (
                  <p>
                    Решение @{item.reviewer}: {item.resolution}
                  </p>
                )}
                <button
                  onClick={() =>
                    propose(
                      item.status === "open"
                        ? {
                            title: `Закрыть жалобу на ${item.project_slug}`,
                            path: `/moderation/reports/${item.id}/resolve`,
                          }
                        : {
                            title: `Открыть жалобу на ${item.project_slug} повторно`,
                            path: `/management/reports/${item.id}/reopen`,
                          },
                    )
                  }
                >
                  {item.status === "open"
                    ? "Рассмотреть жалобу"
                    : "Открыть повторно"}
                </button>
              </>
            )}
            {section === "queue" && (
              <>
                <Markdown
                  text={(item.changelog as string) || ""}
                  token={token}
                />
                <details>
                  <summary>Манифест и разрешения</summary>
                  <pre>{JSON.stringify(item.manifest, null, 2)}</pre>
                </details>
                <ManifestContentLinks manifest={item.manifest} parent={item.title || item.slug || item.id} />
                <div className="actions">
                  <button
                    onClick={() =>
                      void download(
                        "release",
                        item.id,
                        `${item.slug}-${item.version}.zip`,
                      )
                    }
                  >
                    Скачать для проверки
                  </button>
                  <button onClick={() => setSelected(item)}>
                    Карточка проекта
                  </button>
                  <button
                    className="primary"
                    onClick={() =>
                      propose({
                        title: `Одобрить ${item.slug} ${item.version}`,
                        path: `/moderation/${item.id}/approve`,
                      })
                    }
                  >
                    Одобрить
                  </button>
                  <button
                    className="danger"
                    onClick={() =>
                      propose({
                        title: `Отклонить ${item.slug} ${item.version}`,
                        path: `/moderation/${item.id}/reject`,
                      })
                    }
                  >
                    Отклонить
                  </button>
                </div>
              </>
            )}
            {section === "uploads" && (
              <>
                <p>{formatBytes(item.expected_size ?? 0)}</p>
                {item.error && <ErrorNotice>{item.error}</ErrorNotice>}
              </>
            )}
          </article>
        ))}
      </fieldset>
      <div className="management-pagination">
        <button
          disabled={loading || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 30))}
        >
          Назад
        </button>
        <span>
          {page.total
            ? `${offset + 1}–${Math.min(offset + 30, page.total)} из ${page.total}`
            : "0 результатов"}
        </span>
        <button
          disabled={loading || offset + 30 >= page.total}
          onClick={() => setOffset(offset + 30)}
        >
          Далее
        </button>
      </div>
      {deletedRecord && <Modal title={`Удалённый проект: ${deletedRecord.title}`} close={() => setDeletedRecord(null)}>
        {deletedRecord.previous_deletions?.map(entry => <details key={entry.id}><summary>Предыдущее удаление · {new Date(entry.created_at).toLocaleString("ru")}</summary><p>{entry.reason}</p><pre>{JSON.stringify(entry.record, null, 2)}</pre></details>)}
        <p>{deletedRecord.package_id || deletedRecord.slug} · {text(deletedRecord.status)} · {new Date(deletedRecord.deleted_at).toLocaleString("ru")}</p>
        {deletedRecord.package_id && <small>Внутренняя запись: {deletedRecord.slug}</small>}
        <h3>Версии</h3>
        {deletedRecord.snapshot.releases.map(release => <div key={release.id}><strong>{release.version} · {text(release.status)}</strong><p>{release.review || "Без решения модератора"}</p><small>{release.id}</small></div>)}
        <h3>Жалобы</h3>
        {!deletedRecord.snapshot.reports.length && <p>Жалоб не было.</p>}
        {deletedRecord.snapshot.reports.map(report => <div key={report.id}><strong>{report.reason} · {text(report.status)}</strong><p>{report.details}</p><p>{report.resolution || "Без решения модератора"}</p></div>)}
      </Modal>}
      {selected && (
        <EntityManager
          key={selected.id}
          section={section}
          item={selected}
          token={token}
          role={role}
          username={username}
          manager={manager}
          close={() => setSelected(null)}
          propose={propose}
          download={download}
        />
      )}
      {action && (
        <Modal
          title={action.title}
          close={() => setAction(null)}
          busy={busy}
          closeOnBackdrop={false}
        >
          <div className="management-entity">
            {action.note && <p>{action.note}</p>}
            <label>
              Причина / результат проверки
              <textarea
                autoFocus
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                minLength={3}
                maxLength={2000}
              />
            </label>
            <p>Действие и причина будут сохранены в истории.</p>
            {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
            <div className="modal-actions">
              <button disabled={busy} onClick={() => setAction(null)}>
                Отмена
              </button>
              <button
                className="primary"
                disabled={busy || reason.trim().length < 3}
                onClick={() => void perform()}
              >
                Подтвердить
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function EntityManager({
  section,
  item,
  token,
  role,
  username,
  manager,
  close,
  propose,
  download,
}: {
  section: Section;
  item: Item;
  token: string;
  role: string;
  username: string;
  manager: boolean;
  close: () => void;
  propose: (action: Action) => void;
  download: (kind: string, id: string, filename: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(item);
  const [newRole, setNewRole] = useState(item.role ?? "user");
  const [quota, setQuota] = useState(
    item.storage_limit ? String(item.storage_limit / 1024 ** 3) : "",
  );
  const [target, setTarget] = useState("");
  const [memberRole, setMemberRole] = useState("member");
  const [error, setError] = useState("");
  const [releases, setReleases] = useState<Item[]>([]);
  const [releaseOffset, setReleaseOffset] = useState(0);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [revisionOffset, setRevisionOffset] = useState(0);
  const [selectedRevision, setSelectedRevision] = useState<Revision | null>(
    null,
  );
  const project = section === "projects" || section === "queue";
  const path = `/management/projects/${encodeURIComponent(item.slug ?? "")}`;
  const canManage =
    item.username !== username &&
    item.role !== "owner" &&
    (role === "owner" || item.role !== "admin");
  useEffect(() => {
    if (!project) return;
    let active = true;
    void Promise.all([
      registryRequest<Item[]>(
        `${path}/releases?offset=${releaseOffset}`,
        undefined,
        token,
      ),
      registryRequest<Revision[]>(
        `${path}/revisions?offset=${revisionOffset}`,
        undefined,
        token,
      ),
      registryRequest<Item>(path, undefined, token),
    ])
      .then(([rs, revs, p]) => {
        if (active) {
          setReleases(rs);
          setRevisions(revs);
          if (p && section === "queue") setDraft(p);
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [project, path, item.slug, token, revisionOffset, releaseOffset, section]);
  return (
    <Modal
      title={item.title || item.name || item.username || "Управление"}
      close={close}
      busy={false}
      className={project ? "management-project-dialog" : undefined}
    >
      <div className="management-entity">
        {error && <ErrorNotice>{error}</ErrorNotice>}
        {section === "users" && (
          <>
            {!canManage && (
              <p>
                {item.role === "owner"
                  ? "Владелец платформы защищён от блокировки и смены роли."
                  : "Собственные права и аккаунты администраторов здесь менять нельзя."}
              </p>
            )}
            {canManage && (
              <>
                <label>
                  Роль
                  <Select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value)}
                  >
                    <option value="user">Автор</option>
                    <option value="moderator">Модератор</option>
                    {role === "owner" && (
                      <option value="admin">Администратор</option>
                    )}
                  </Select>
                </label>
                <button
                  disabled={newRole === item.role}
                  onClick={() =>
                    propose({
                      title: `Роль @${item.username}: ${text(item.role)} → ${text(newRole)}`,
                      path: `/admin/users/${encodeURIComponent(item.username!)}/role`,
                      method: "PUT",
                      fields: { role: newRole },
                    })
                  }
                >
                  Изменить роль
                </button>
                <div className="actions">
                  <button
                    onClick={() =>
                      propose({
                        title: `${item.blocked ? "Разблокировать" : "Заблокировать"} @${item.username}`,
                        path: `/management/users/${encodeURIComponent(item.username!)}/block`,
                        method: "PUT",
                        fields: { blocked: !item.blocked },
                        note: "Блокировка запрещает вход и новые действия. Существующие публикации можно скрыть отдельно.",
                      })
                    }
                  >
                    {item.blocked ? "Разблокировать" : "Заблокировать"}
                  </button>
                  <button
                    onClick={() =>
                      propose({
                        title: `Завершить все сессии @${item.username}`,
                        path: `/management/users/${encodeURIComponent(item.username!)}/revoke-sessions`,
                      })
                    }
                  >
                    Завершить сессии
                  </button>
                </div>
              </>
            )}
            {(canManage || item.username === username) && (
              <>
                <label>
                  Квота, ГиБ (пусто - общий лимит)
                  <input
                    type="number"
                    min="0.001"
                    step="any"
                    value={quota}
                    onChange={(e) => setQuota(e.target.value)}
                  />
                </label>
                <button
                  disabled={
                    quota !== "" &&
                    (!Number.isFinite(Number(quota)) || Number(quota) <= 0)
                  }
                  onClick={() =>
                    propose({
                      title: `Изменить квоту @${item.username}`,
                      path: `/management/users/${encodeURIComponent(item.username!)}/quota`,
                      method: "PUT",
                      fields: {
                        storage_limit: quota
                          ? Math.round(Number(quota) * 1024 ** 3)
                          : null,
                      },
                    })
                  }
                >
                  Сохранить квоту
                </button>
              </>
            )}
          </>
        )}
        {project && (
          <>
            <p>{draft.summary}</p>
            <Markdown text={draft.description ?? ""} token={token} />
            <div className="review-images">
              {draft.media?.map((m) => (
                <div key={m.id}>
                  <PrivateImage
                    src={registryMediaUrl(`${registryUrl}/media/${m.id}`, registryUrl)!}
                    alt="Изображение проекта"
                    token={token}
                  />
                  {manager && (
                    <button
                      onClick={() =>
                        propose({
                          title: `Удалить изображение ${draft.title}`,
                          path: `${path}/media/${m.id}`,
                          method: "DELETE",
                        })
                      }
                    >
                      Удалить изображение
                    </button>
                  )}
                </div>
              ))}
            </div>
            <h3>Состояние публикации</h3>
            <p>Сейчас: {text(draft.status)}</p>
            <div className="actions">
              {["published", "review", "draft", "blocked", "archived"]
                .filter((s) => s !== draft.status)
                .map((s) => (
                  <button
                    key={s}
                    onClick={() =>
                      propose({
                        title: `${draft.title}: ${text(draft.status)} → ${text(s)}`,
                        path: `/moderation/projects/${item.slug}/visibility`,
                        fields: { status: s },
                      })
                    }
                  >
                    {text(s)}
                  </button>
                ))}
            </div>
            {manager && (
              <details>
                <summary>Исправить карточку и владельца</summary>
                <label>
                  Название
                  <input
                    value={draft.title ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, title: e.target.value })
                    }
                  />
                </label>
                <label>
                  Краткое описание
                  <input
                    value={draft.summary ?? ""}
                    maxLength={512}
                    onChange={(e) =>
                      setDraft({ ...draft, summary: e.target.value })
                    }
                  />
                </label>
                <label>
                  Описание
                  <textarea
                    value={draft.description ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                  />
                </label>
                <label>
                  Лицензия
                  <input
                    value={draft.license ?? ""}
                    onChange={(e) =>
                      setDraft({ ...draft, license: e.target.value })
                    }
                  />
                </label>
                <CategoryPicker
                  kind={draft.kind ?? "mod"}
                  value={draft.categories ?? []}
                  onChange={(categories) => setDraft({ ...draft, categories })}
                />
                <button
                  disabled={!draft.title?.trim()}
                  onClick={() =>
                    propose({
                      title: `Сохранить карточку ${draft.title}`,
                      path,
                      method: "PUT",
                      fields: {
                        title: draft.title,
                        summary: draft.summary ?? "",
                        description: draft.description ?? "",
                        license: draft.license || null,
                        categories:
                          draft.categories
                            ?.map((c) => c.trim())
                            .filter(Boolean) ?? [],
                      },
                    })
                  }
                >
                  Сохранить исправления
                </button>
                <label>
                  Новый владелец
                  <input
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                    placeholder="Имя пользователя"
                  />
                </label>
                <button
                  disabled={!target.trim()}
                  onClick={() =>
                    propose({
                      title: `Передать ${draft.title} пользователю @${target}`,
                      path: `${path}/transfer`,
                      fields: { username: target.trim() },
                      note: "Связь с прежней командой будет снята. Прямые участники проекта сохранят свои роли.",
                    })
                  }
                >
                  Передать проект
                </button>
              </details>
            )}
            <details>
              <summary>Версии проекта</summary>
              <div className="actions">
                <button
                  disabled={!releaseOffset}
                  onClick={() =>
                    setReleaseOffset(Math.max(0, releaseOffset - 30))
                  }
                >
                  Предыдущие
                </button>
                <span>Страница {releaseOffset / 30 + 1}</span>
                <button
                  disabled={releases.length < 30}
                  onClick={() => setReleaseOffset(releaseOffset + 30)}
                >
                  Следующие
                </button>
              </div>
              {releases.map((r) => (
                <article key={r.id}>
                  <h4>
                    {r.version} · {text(r.status)}
                  </h4>
                  <div className="actions">
                    <button
                      onClick={() =>
                        void download(
                          "release",
                          r.id,
                          `${item.slug}-${r.version}.zip`,
                        )
                      }
                    >
                      Скачать архив
                    </button>
                    {r.status === "published" && (
                      <button
                        onClick={() =>
                          propose({
                            title: `Снять ${item.slug} ${r.version}`,
                            path: `/management/releases/${r.id}/withdraw`,
                          })
                        }
                      >
                        Снять версию
                      </button>
                    )}
                    {["yanked", "rejected"].includes(r.status ?? "") && (
                      <button
                        onClick={() =>
                          propose({
                            title: `Вернуть ${item.slug} ${r.version} на проверку`,
                            path: `/management/releases/${r.id}/reopen`,
                          })
                        }
                      >
                        На пересмотр
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </details>
            <details>
              <summary>История редакций</summary>
              <p>
                Хранятся последние 100 редакций, созданных после обновления
                сервера. Восстановление не меняет статус публикации.
              </p>
              {revisions.map((r) => (
                <button key={r.id} onClick={() => setSelectedRevision(r)}>
                  #{r.id} · {new Date(r.created_at).toLocaleString("ru")} ·{" "}
                  {text(r.snapshot.status)}
                </button>
              ))}
              <div className="actions">
                <button
                  disabled={!revisionOffset}
                  onClick={() =>
                    setRevisionOffset(Math.max(0, revisionOffset - 30))
                  }
                >
                  Новее
                </button>
                <button
                  disabled={revisions.length < 30}
                  onClick={() => setRevisionOffset(revisionOffset + 30)}
                >
                  Старше
                </button>
              </div>
              {selectedRevision && (
                <>
                  <div className="revision-comparison">
                    <section>
                      <h4>Редакция #{selectedRevision.id}</h4>
                      <strong>{selectedRevision.snapshot.title}</strong>
                      <p>{selectedRevision.snapshot.summary}</p>
                      <Markdown
                        text={selectedRevision.snapshot.description}
                        token={token}
                      />
                      <div className="review-images">
                        {selectedRevision.snapshot.media?.map((m) => (
                          <PrivateImage
                            key={m.id}
                            src={`${registryUrl}${path}/revisions/${selectedRevision.id}/media/${m.id}`}
                            alt="Изображение из редакции"
                            token={token}
                          />
                        ))}
                      </div>
                      <p>
                        Категории:{" "}
                        {selectedRevision.snapshot.categories.join(", ")}
                      </p>
                    </section>
                    <section>
                      <h4>Сейчас</h4>
                      <strong>{draft.title}</strong>
                      <p>{draft.summary}</p>
                      <Markdown text={draft.description ?? ""} token={token} />
                      <p>Изображений: {draft.media?.length ?? 0}</p>
                      <p>Категории: {draft.categories?.join(", ")}</p>
                    </section>
                  </div>
                  {manager && (
                    <button
                      onClick={() =>
                        propose({
                          title: `Восстановить редакцию #${selectedRevision.id} проекта ${draft.title}`,
                          path: `${path}/revisions/${selectedRevision.id}/restore`,
                        })
                      }
                    >
                      Восстановить эту редакцию
                    </button>
                  )}
                </>
              )}
            </details>
          </>
        )}
        {section === "organizations" && (
          <>
            <p>{item.description}</p>
            {item.members?.map((m) => (
              <p key={m.username}>
                @{m.username} · {text(m.role)}
              </p>
            ))}
            <label>
              Пользователь
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            <label>
              Роль
              <Select
                value={memberRole}
                onChange={(e) => setMemberRole(e.target.value)}
              >
                <option value="member">Участник</option>
                <option value="maintainer">Управляющий</option>
                <option value="remove">Удалить из команды</option>
              </Select>
            </label>
            <button
              disabled={!target.trim()}
              onClick={() =>
                propose({
                  title: `Изменить участие @${target} в ${item.name}`,
                  path: `/management/organizations/${item.slug}/members`,
                  method: "PUT",
                  fields: { username: target.trim(), role: memberRole },
                })
              }
            >
              Изменить участника
            </button>
            <button
              disabled={!target.trim()}
              onClick={() =>
                propose({
                  title: `Передать команду ${item.name} пользователю @${target}`,
                  path: `/management/organizations/${item.slug}/transfer`,
                  fields: { username: target.trim() },
                  note: "Прежний владелец останется управляющим.",
                })
              }
            >
              Передать владение
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}
