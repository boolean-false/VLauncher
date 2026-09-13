import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { registryRequest } from "../api";
import { useRegistryResource } from "../useResource";
import { formatBytes, friendlyError } from "../model";
import {
  displayFiles,
  filesReady,
  groupReleases,
  platformName,
  releaseStatus,
  type LauncherRelease,
  type LauncherFile,
} from "../launcherReleases";
import { ErrorNotice, Modal } from "./ui";
import { Markdown } from "./Markdown";
import { Select } from "./Select";

type Action = {
  kind: "publish" | "notes" | "delete" | "withdraw";
  builds: LauncherRelease[];
};
const actionNames = {
  publish: "Опубликовать сборки",
  notes: "Изменить описание",
  delete: "Удалить черновик",
  withdraw: "Отозвать сборку",
};

export function LauncherReleases({
  token,
  revision,
}: {
  token: string;
  revision: number;
}) {
  const data = useRegistryResource<LauncherRelease[]>(
    "/admin/launcher-releases",
    token,
  );
  const previousRevision = useRef(revision);
  useEffect(() => {
    if (previousRevision.current !== revision) {
      previousRevision.current = revision;
      data.refresh();
    }
  }, [revision, data.refresh]);
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState("");
  const [status, setStatus] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [notes, setNotes] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const groups = groupReleases(data.data ?? []);
  const visible = groups.filter(
    (g) =>
      g.version.includes(query.trim()) &&
      (!channel || g.channel === channel) &&
      (!status || g.builds.some((b) => b.status === status)),
  );
  const begin = (kind: Action["kind"], builds: LauncherRelease[]) => {
    setAction({ kind, builds });
    setNotes(builds[0]?.notes ?? "");
    setReason("");
    setActionError("");
    setNotice("");
  };
  const download = async (file: LauncherFile) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const path = await save({ defaultPath: file.filename });
      if (!path) return;
      setNotice(`Скачиваем ${file.filename}…`);
      await invoke("download_review_file", {
        kind: "launcher",
        id: file.id,
        path,
        token,
      });
      setNotice(`Файл сохранён: ${path}`);
    } catch (e) {
      setNotice("");
      setError(friendlyError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const perform = async () => {
    if (!action || lock.current) return;
    lock.current = true;
    setBusy(true);
    setActionError("");
    const completed: string[] = [];
    try {
      const current = await registryRequest<LauncherRelease[]>(
        "/admin/launcher-releases",
        { cache: "reload" },
        token,
      );
      if (action.kind === "publish" || action.kind === "delete") {
        const latest = action.builds.map((build) =>
          current.find((item) => item.id === build.id),
        );
        if (latest.some((build) => build?.status !== "draft")) {
          throw new Error("Состояние выпуска изменилось. Обновите список.");
        }
        await registryRequest(
          action.kind === "publish"
            ? "/admin/launcher-releases/publish"
            : "/admin/launcher-releases/github-draft",
          {
            method: action.kind === "publish" ? "POST" : "DELETE",
            body: JSON.stringify({
              release_ids: action.builds.map((build) => build.id),
              reason:
                reason.trim() ||
                (action.kind === "publish"
                  ? "Публикация проверенного выпуска"
                  : "Удаление черновика выпуска"),
            }),
          },
          token,
        );
        completed.push(...action.builds.map((build) => build.id));
      }
      for (const build of action.builds) {
        if (action.kind === "publish" || action.kind === "delete") break;
        const latest = current.find((item) => item.id === build.id);
        // В прошлый раз сервер мог сохранить запрос, но не вернуть ответ.
        if (
          (action.kind === "withdraw" && latest?.status === "withdrawn") ||
          (action.kind === "notes" && latest?.notes === notes)
        ) {
          completed.push(build.id);
          continue;
        }
        const path = `/management/launcher/${build.id}/${action.kind}`;
        await registryRequest(
          path,
          {
            method: action.kind === "notes" ? "PUT" : "POST",
            body: JSON.stringify({
              reason: reason.trim() || "Изменение выпуска",
              ...(action.kind === "notes" ? { notes } : {}),
            }),
          },
          token,
        );
        completed.push(build.id);
      }
      setNotice(`${actionNames[action.kind]}: готово (${completed.length}).`);
      setAction(null);
    } catch (e) {
      setAction({
        ...action,
        builds: action.builds.filter((b) => !completed.includes(b.id)),
      });
      setActionError(
        `Выполнено: ${completed.length} из ${action.builds.length}. ${friendlyError(e)} Повтор применяется только к оставшимся сборкам.`,
      );
    } finally {
      data.refresh();
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="launcher-releases">
      <div className="launcher-release-filters">
        <label>
          Версия
          <input
            value={query}
            placeholder="Найти версию…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label>
          Канал
          <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">Все каналы</option>
            <option value="stable">Стабильный</option>
            <option value="beta">Бета</option>
          </Select>
        </label>
        <label>
          Состояние
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Все состояния</option>
            {Object.entries(releaseStatus).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {(error || data.error) && (
        <ErrorNotice retry={data.refresh}>{error || data.error}</ErrorNotice>
      )}
      {notice && <p role="status">{notice}</p>}
      {data.loading && <p role="status">Загружаем выпуски…</p>}
      {!data.loading && !visible.length && (
        <p>
          {groups.length
            ? "Выпуски по этим условиям не найдены."
            : "Выпусков пока нет."}
        </p>
      )}
      {visible.map((group) => {
        const drafts = group.builds.filter((b) => b.status === "draft");
        const ready =
          drafts.length === group.builds.length && drafts.every(filesReady);
        const sameNotes = group.builds.every(
          (b) => b.notes === group.builds[0].notes,
        );
        const published = group.builds.filter(
          (b) => b.status === "published",
        ).length;
        const groupState = group.builds.every(
          (b) => b.status === group.builds[0].status,
        )
          ? releaseStatus[group.builds[0].status]
          : `Опубликовано ${published} из ${group.builds.length}`;
        return (
          <article className="launcher-release" key={group.key}>
            <header className="section-heading">
              <h3>VLauncher {group.version}</h3>
              <span>
                {group.channel === "stable" ? "Стабильный" : "Бета"} ·{" "}
                {groupState}
              </span>
            </header>
            <div className="launcher-release-notes">
              <details>
                <summary>Изменения в выпуске</summary>
                {sameNotes ? (
                  <Markdown
                    text={group.builds[0].notes || "Описание не добавлено."}
                    token={token}
                  />
                ) : (
                  <>
                    <p>Описания сборок различаются.</p>
                    {group.builds.map((b) => (
                      <details key={b.id}>
                        <summary>{platformName(b)}</summary>
                        <Markdown
                          text={b.notes || "Описание не добавлено."}
                          token={token}
                        />
                      </details>
                    ))}
                  </>
                )}
              </details>
              {drafts.length > 0 && (
                <button disabled={busy} onClick={() => begin("notes", drafts)}>
                  {drafts.length === group.builds.length
                    ? "Изменить описание"
                    : "Описание черновиков"}
                </button>
              )}
            </div>
            <div className="launcher-builds">
              {group.builds.map((build) => (
                <section className="launcher-build" key={build.id}>
                  <div className="launcher-build-heading">
                    <strong>{platformName(build)}</strong>
                    <span>
                      {filesReady(build)
                        ? "Комплект файлов готов"
                        : "Не хватает файлов"}
                    </span>
                    <span>{releaseStatus[build.status] ?? build.status}</span>
                    {build.status === "published" && (
                      <details className="launcher-build-actions">
                        <summary>Действия</summary>
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() => begin("withdraw", [build])}
                        >
                          Отозвать сборку
                        </button>
                      </details>
                    )}
                  </div>
                  <details className="launcher-build-files">
                    <summary>
                      Файлы · {displayFiles(build.files).length}
                    </summary>
                    {displayFiles(build.files).map(({ file, kinds }) => (
                      <div className="launcher-release-file" key={file.id}>
                        <div>
                          <strong>
                            {kinds.includes("installer") &&
                            kinds.includes("update")
                              ? "Установщик и обновление"
                              : kinds.includes("installer")
                                ? "Установщик"
                                : "Обновление"}
                          </strong>
                          <p>
                            {file.filename} · {formatBytes(file.size)}
                          </p>
                          {kinds.includes("update") && (
                            <small>
                              Подпись добавлена в GitHub draft.
                            </small>
                          )}
                          <details>
                            <summary>SHA-256</summary>
                            <code className="selectable">{file.sha256}</code>
                          </details>
                        </div>
                        <button
                          disabled={busy}
                          onClick={() => void download(file)}
                        >
                          Скачать для проверки
                        </button>
                      </div>
                    ))}
                    {!filesReady(build) && (
                      <p>
                        Для публикации нужны установщик и подписанный файл
                        обновления.
                      </p>
                    )}
                  </details>
                </section>
              ))}
            </div>
            {drafts.length > 0 && (
              <footer className="launcher-release-footer">
                <p>Готовность файлов не заменяет проверку установки на ОС.</p>
                <div className="actions">
                  {drafts.length === group.builds.length && (
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() => begin("delete", drafts)}
                    >
                      Удалить черновик
                    </button>
                  )}
                  <button
                    className="primary"
                    disabled={busy || !!data.error || !ready}
                    onClick={() => begin("publish", drafts)}
                  >
                    Опубликовать выпуск
                  </button>
                </div>
              </footer>
            )}
          </article>
        );
      })}
      {action && (
        <Modal
          title={actionNames[action.kind]}
          busy={busy}
          closeOnBackdrop={false}
          close={() => setAction(null)}
        >
          <p>
            VLauncher {action.builds[0]?.version} ·{" "}
            {action.builds[0]?.channel === "stable"
              ? "Стабильный канал"
              : "Бета-канал"}
          </p>
          <ul>
            {action.builds.map((b) => (
              <li key={b.id}>{platformName(b)}</li>
            ))}
          </ul>
          {action.kind === "publish" && (
            <p>
              GitHub Release станет публичным, а VSpace получит ссылки на его
              файлы. После этого сборки будут предложены как обновление.
            </p>
          )}
          {action.kind === "withdraw" && (
            <p>
              Новые скачивания и предложения обновиться прекратятся.
              Установленные копии автоматически не откатятся.
            </p>
          )}
          {action.kind === "delete" && (
            <p>
              GitHub draft и запись VSpace будут удалены. Выпуск с этим номером
              можно будет собрать заново.
            </p>
          )}
          {action.kind === "notes" && (
            <label>
              Общее описание выпуска
              <textarea
                rows={10}
                maxLength={20000}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                disabled={busy}
              />
              <small>
                Markdown. Описание будет сохранено для всех перечисленных
                сборок.
              </small>
            </label>
          )}
          <label>
            Комментарий для истории
            {action.kind === "publish" ? " (необязательно)" : ""}
            <textarea
              value={reason}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
            />
          </label>
          {actionError && <ErrorNotice>{actionError}</ErrorNotice>}
          <div className="modal-actions">
            <button disabled={busy} onClick={() => setAction(null)}>
              Отмена
            </button>
            <button
              className={
                action.kind === "delete" || action.kind === "withdraw"
                  ? "danger"
                  : "primary"
              }
              disabled={
                busy || (action.kind !== "publish" && reason.trim().length < 3)
              }
              onClick={() => void perform()}
            >
              {busy
                ? "Выполняем…"
                : action.kind === "notes"
                  ? "Сохранить"
                  : actionNames[action.kind]}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
