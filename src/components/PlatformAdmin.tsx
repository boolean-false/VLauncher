import { LauncherAnalytics } from "./LauncherAnalytics";
import { LauncherReleases } from "./LauncherReleases";
import { FeedbackQueue } from "./FeedbackQueue";
import { CleanupPanel } from "./CleanupPanel";
import { useCallback, useEffect, useState } from "react";
import { registryRequest } from "../api";
import { ManagementPanel } from "./ManagementPanel";
import { ErrorNotice } from "./ui";

type Category = {
  id: string;
  name: string;
  kinds: string[];
  active: boolean;
  project_count?: number;
};
type Limits = { projects_per_day: number; teams_per_day: number; project_slots: number; team_slots: number };
const limitLabels = { projects_per_day: "Проектов за сутки", teams_per_day: "Команд за сутки", project_slots: "Проектов и резервирований на аккаунт", team_slots: "Команд во владении" };
const kinds = { mod: "Контент-паки", modpack: "Сборки", world: "Карты" };
const emptyCategory = (): Category => ({
  id: "",
  name: "",
  kinds: ["mod"],
  active: true,
});
export function PlatformAdmin({
  token,
  role,
  username,
}: {
  token: string;
  role: string;
  username: string;
}) {
  const manager = ["owner", "admin"].includes(role);
  const [tab, setTab] = useState("queue");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Category>(emptyCategory);
  const [limits, setLimits] = useState<Limits>({ projects_per_day: 10, teams_per_day: 3, project_slots: 30, team_slots: 10 });
  const [autoApprove, setAutoApprove] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = useCallback(
    <T,>(path: string, init?: RequestInit) =>
      registryRequest<T>(path, init, token),
    [token],
  );
  useEffect(() => {
    if (!["categories", "settings"].includes(tab)) return;
    let active = true;
    setLoading(true);
    void (
      tab === "categories"
        ? request<Category[]>("/admin/categories").then((value) => {
            if (active) setCategories(value);
          })
        : request<Limits & { auto_approve: boolean }>("/admin/moderation-settings").then(
            (value) => {
              if (active) { setAutoApprove(value.auto_approve); setLimits(value); }
            },
          )
    )
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [tab, request, revision]);
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await work();
      setRevision((n) => n + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const post = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });
  const sections = [
    ["queue", "Версии на проверке"],
    ["cards", "Карточки на проверке"],
    ["reports", "Жалобы"],
    ["projects", "Проекты"],
    ["cleanup", "Очистка"],
    ["feedback", "Обращения"],
    ...(manager
      ? [
          ["users", "Аккаунты"],
          ["organizations", "Команды"],
          ["categories", "Категории"],
          ["settings", "Модерация"],
          ["launcher", "VLauncher"],
          ["uploads", "Загрузки"],
        ]
      : []),
    ...(role === "owner" ? [["analytics", "Статистика"]] : []),
    ["history", "История"],
  ];
  return (
    <section className="platform-admin">
      <div className="section-heading">
        <div>
          <h2>Управление платформой</h2>
          <p>
            {role === "owner"
              ? "Владелец платформы"
              : role === "admin"
                ? "Администратор"
                : "Модератор"}{" "}
            · @{username}
          </p>
        </div>
        <button
          disabled={busy || loading}
          onClick={() => {
            setError("");
            setRevision((n) => n + 1);
          }}
        >
          Обновить
        </button>
      </div>
      <nav className="workshop-project-tabs" aria-label="Разделы управления">
        {sections.map(([id, name]) => (
          <button
            key={id}
            disabled={busy}
            className={tab === id ? "active" : ""}
            onClick={() => {
              setTab(id);
              setError("");
            }}
          >
            {name}
          </button>
        ))}
      </nav>
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {tab === "analytics" && role === "owner" && <LauncherAnalytics token={token} revision={revision} />}
      {tab === "feedback" && <FeedbackQueue request={request} revision={revision} />}
      {tab === "cleanup" && <CleanupPanel token={token} role={role} revision={revision} />}
      {tab === "launcher" && manager && <LauncherReleases token={token} revision={revision} />}
      {!["categories", "settings", "cleanup", "analytics", "feedback", "launcher"].includes(tab) && (
        <ManagementPanel
          key={tab}
          section={
            (tab === "cards" ? "projects" : tab) as
              | "queue"
              | "projects"
              | "reports"
              | "users"
              | "organizations"
              | "uploads"
              | "history"
          }
          initialState={tab === "cards" ? "review" : ""}
          token={token}
          role={role}
          username={username}
          revision={revision}
        />
      )}
      {loading && <p role="status">Загрузка…</p>}
      <fieldset disabled={busy || loading} className="creator-fieldset">
        {tab === "settings" && (
          <section className="form-card">
            <h3>Автоматическое одобрение</h3>
            <p>
              Новые версии и правки опубликованных карточек выходят после
              проверки файлов без ручной модерации. Заблокированные и архивные
              проекты сохраняют своё состояние.
            </p>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={e => setAutoApprove(e.target.checked)}
              />
              Одобрять автоматически
            </label>
            <p>Уже ожидающие проверки заявки рассматриваются отдельно.</p>
            <h3>Ограничения создания</h3>
            <p>Применяются ко всем аккаунтам, кроме владельца платформы. Не более трёх созданий одного типа в минуту. Удаление не сбрасывает суточный лимит; зарезервированные имена занимают место.</p>
            {(Object.keys(limitLabels) as (keyof Limits)[]).map(key => <label key={key}>{limitLabels[key]}<input type="number" min={1} max={10000} value={limits[key]} onChange={e => setLimits(v => ({ ...v, [key]: Number(e.target.value) }))} /></label>)}
            <button className="primary" disabled={busy || Object.keys(limitLabels).some(key => !Number.isInteger(limits[key as keyof Limits]) || limits[key as keyof Limits] < 1 || limits[key as keyof Limits] > 10000)} onClick={() => void act(() => post("/admin/moderation-settings", { ...limits, auto_approve: autoApprove }, "PUT"))}>Сохранить настройки</button>
          </section>
        )}
        {tab === "categories" && (
          <div className="category-management">
            <div>
              <h3>Категории каталога</h3>
              <p>
                Отключённые категории недоступны для выбора. Существующие
                отметки проектов сохраняются.
              </p>
              {categories.map((c) => (
                <button
                  className="category-admin-row"
                  key={c.id}
                  onClick={() => setDraft({ ...c })}
                >
                  <span>
                    <strong>{c.name}</strong>
                    <small>
                      {c.id} ·{" "}
                      {c.kinds
                        .map((k) => kinds[k as keyof typeof kinds])
                        .join(", ")}
                    </small>
                  </span>
                  <span>{c.active ? "Включена" : "Отключена"}</span>
                </button>
              ))}
            </div>
            <form
              className="form-card"
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await post("/admin/categories/" + draft.id, draft, "PUT");
                  setDraft({ id: "", name: "", kinds: ["mod"], active: true });
                });
              }}
            >
              <h3>
                {categories.some((c) => c.id === draft.id)
                  ? "Редактирование категории"
                  : "Новая категория"}
              </h3>
              <label>
                Идентификатор
                <input
                  required
                  pattern="[a-z][a-z0-9_-]{1,31}"
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </label>
              <label>
                Название
                <input
                  required
                  maxLength={100}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <div className="category-kind-checks">
                {Object.entries(kinds).map(([id, name]) => (
                  <label key={id}>
                    <input
                      type="checkbox"
                      checked={draft.kinds.includes(id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          kinds: e.target.checked
                            ? [...draft.kinds, id]
                            : draft.kinds.filter((k) => k !== id),
                        })
                      }
                    />
                    {name}
                  </label>
                ))}
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) =>
                    setDraft({ ...draft, active: e.target.checked })
                  }
                />
                Доступна в каталоге
              </label>
              <div className="actions">
                <button className="primary" disabled={!draft.kinds.length}>
                  Сохранить
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setDraft({ id: "", name: "", kinds: ["mod"], active: true })
                  }
                >
                  Новая категория
                </button>
                {categories.some((c) => c.id === draft.id) && (
                  <button
                    type="button"
                    className="danger"
                    disabled={
                      busy ||
                      !!categories.find((c) => c.id === draft.id)?.project_count
                    }
                    onClick={() =>
                      void act(async () => {
                        await request(
                          `/admin/categories/${encodeURIComponent(draft.id)}`,
                          { method: "DELETE" },
                        );
                        setDraft({
                          id: "",
                          name: "",
                          kinds: ["mod"],
                          active: true,
                        });
                      })
                    }
                  >
                    Удалить пустую категорию
                  </button>
                )}
              </div>
              {categories.some(
                (c) => c.id === draft.id && !!c.project_count,
              ) && (
                <p>
                  Категория используется в проектах:{" "}
                  {categories.find((c) => c.id === draft.id)?.project_count}.
                  Доступно только отключение.
                </p>
              )}
            </form>
          </div>
        )}
      </fieldset>
    </section>
  );
}
