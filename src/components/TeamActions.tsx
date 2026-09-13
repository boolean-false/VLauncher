import { useEffect, useState } from "react";
import { Modal } from "./ui";
type Info = {
  role: string;
  members: { username: string; role: string }[];
  projects: { slug: string; title: string; owner: string }[];
};
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
export function TeamActions({
  slug,
  request,
  changed,
}: {
  slug: string;
  request: Request;
  changed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Info | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("member");
  const [action, setAction] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const base = `/organizations/${encodeURIComponent(slug)}`;
  useEffect(() => {
    if (!open) return;
    let live = true;
    void request<Info>(`${base}/lifecycle`, { cache: "no-store" })
      .then((d) => {
        if (live) setData(d);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [base, open, revision]);
  async function run(
    path: string,
    method: string,
    body?: unknown,
    closing = false,
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await request(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setAction("");
      setConfirmation("");
      setRevision((n) => n + 1);
      changed();
      if (closing) {
        setOpen(false);
        setData(null);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const begin = (value: string) => {
    setAction(value);
    setConfirmation("");
    setError("");
  };
  return (
    <>
      <button
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        Участники и настройки
      </button>
      {open && (
        <Modal
          title={`Команда · ${slug}`}
          busy={busy}
          close={() => {
            setOpen(false);
            setAction("");
            setData(null);
          }}
        >
          {error && (
            <p role="alert" className="error-notice">
              {error}{" "}
              <button
                disabled={busy}
                onClick={() => {
                  setError("");
                  setRevision((n) => n + 1);
                }}
              >
                Повторить
              </button>
            </p>
          )}
          {!data ? (
            <p role="status">Загрузка команды…</p>
          ) : (
            <div className="team-settings">
              <h3>Участники · {data.members.length}</h3>
              {data.members.map((m) => (
                <div className="team-member" key={m.username}>
                  <span>
                    @{m.username} ·{" "}
                    {m.role === "owner"
                      ? "Владелец"
                      : m.role === "maintainer"
                        ? "Редактор"
                        : "Участник"}
                  </span>
                  {data.role === "owner" && m.role !== "owner" && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setUsername(m.username);
                        begin("remove");
                      }}
                    >
                      Исключить…
                    </button>
                  )}
                </div>
              ))}
              {data.role === "owner" && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void run(`${base}/members`, "PUT", { username, role });
                  }}
                >
                  <label>
                    Имя пользователя
                    <input
                      required
                      value={username}
                      disabled={busy}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </label>
                  <label>
                    Роль
                    <select
                      value={role}
                      disabled={busy}
                      onChange={(e) => setRole(e.target.value)}
                    >
                      <option value="member">Участник</option>
                      <option value="maintainer">Редактор</option>
                    </select>
                  </label>
                  <button disabled={busy || !username.trim()}>
                    Добавить / изменить роль
                  </button>
                </form>
              )}
              <h3>Проекты · {data.projects.length}</h3>
              <p>
                При удалении команды проекты остаются у личных владельцев.
                Доступ через команду прекращается.
              </p>
              {data.projects.map((p) => (
                <p key={p.slug}>
                  {p.title} · {p.slug} · @{p.owner}
                </p>
              ))}
              {!data.projects.length && <p>Проектов пока нет.</p>}
              {!action && (
                <div className="modal-actions">
                  {data.role === "owner" ? (
                    <>
                      <button
                        disabled={busy || data.members.length < 2}
                        onClick={() => {
                          setUsername(
                            data.members.find((m) => m.role !== "owner")
                              ?.username ?? "",
                          );
                          begin("transfer");
                        }}
                      >
                        Передать владение…
                      </button>
                      <button
                        className="danger"
                        disabled={busy}
                        onClick={() => begin("delete")}
                      >
                        Удалить команду…
                      </button>
                    </>
                  ) : (
                    <button disabled={busy} onClick={() => begin("leave")}>
                      Покинуть команду…
                    </button>
                  )}
                </div>
              )}
              {action && (
                <section className="project-lifecycle-confirm">
                  <h3>
                    {action === "delete"
                      ? "Удалить команду безвозвратно?"
                      : action === "transfer"
                        ? "Передать владение командой?"
                        : action === "remove"
                          ? `Исключить @${username}?`
                          : "Покинуть команду?"}
                  </h3>
                  {action === "transfer" && (
                    <>
                      <p>
                        Вы станете редактором. Вернуть владение сможет новый
                        владелец или администратор.
                      </p>
                      <label>
                        Новый владелец
                        <select
                          disabled={busy}
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                        >
                          {data.members
                            .filter((m) => m.role !== "owner")
                            .map((m) => (
                              <option key={m.username}>{m.username}</option>
                            ))}
                        </select>
                      </label>
                    </>
                  )}
                  <label>
                    Для подтверждения введите {slug}
                    <input
                      value={confirmation}
                      disabled={busy}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setConfirmation(e.target.value)}
                    />
                  </label>
                  <div className="modal-actions">
                    <button disabled={busy} onClick={() => setAction("")}>
                      Отмена
                    </button>
                    <button
                      className="danger"
                      disabled={busy || confirmation !== slug}
                      onClick={() =>
                        void run(
                          action === "delete"
                            ? base
                            : action === "remove"
                              ? `${base}/members/${encodeURIComponent(username)}`
                              : `${base}/${action}`,
                          ["delete", "remove"].includes(action)
                            ? "DELETE"
                            : "POST",
                          { confirm_slug: confirmation, username },
                          ["delete", "leave"].includes(action),
                        )
                      }
                    >
                      {busy ? "Сохраняем…" : "Подтвердить"}
                    </button>
                  </div>
                </section>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
