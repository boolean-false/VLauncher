import type { ProjectDetail, Release } from "../api";
import { updateReleaseNotes } from "../releaseNotes";
import { useRegistryResource } from "../useResource";
import { Markdown } from "./Markdown";
import { ErrorNotice, Modal } from "./ui";

export function UpdateReleaseNotes({
  packageId,
  title,
  installed,
  target,
  busy,
  canUpdate,
  close,
  update,
}: {
  packageId: string;
  title: string;
  installed: string;
  target: string;
  busy: boolean;
  canUpdate: boolean;
  close: () => void;
  update: () => void;
}) {
  const path = `/projects/${encodeURIComponent(packageId)}`;
  const project = useRegistryResource<ProjectDetail>(path);
  const releases = useRegistryResource<Release[]>(`${path}/releases`);
  const notes = updateReleaseNotes(releases.data ?? [], installed, target);
  return (
    <Modal
      title={`Изменения · ${project.data?.title || title}`}
      busy={busy}
      close={close}
    >
      <p className="release-notes-transition">
        {installed} → {target}
      </p>
      {releases.loading && !releases.data && (
        <p role="status">Загружаем список изменений…</p>
      )}
      {releases.error && (
        <ErrorNotice retry={releases.refresh}>{releases.error}</ErrorNotice>
      )}
      {notes.map((release) => (
        <section className="update-release-notes" key={release.version}>
          <h3>
            {release.version} ·{" "}
            {release.channel === "stable" ? "Стабильная" : release.channel}
          </h3>
          {release.changelog?.trim() ? (
            <Markdown text={release.changelog} />
          ) : (
            <p className="muted">Автор не добавил список изменений.</p>
          )}
        </section>
      ))}
      {!releases.loading && !releases.error && !notes.length && (
        <p className="muted">Список изменений для этих версий недоступен.</p>
      )}
      {!canUpdate && (
        <p className="muted">Завершите игру, чтобы обновить пак.</p>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={close}>
          Закрыть
        </button>
        <button
          className="primary"
          disabled={busy || !canUpdate}
          onClick={update}
        >
          Обновить…
        </button>
      </div>
    </Modal>
  );
}
