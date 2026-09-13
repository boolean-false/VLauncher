import { useState } from "react";
import type { ProjectMedia } from "../api";
import { PrivateImage } from "./PrivateImage";
import { Modal } from "./ui";

export function ProjectMediaEditor({ media, token, loading, error, retry, busy, add, remove, insert }: {
  media: ProjectMedia[];
  token: string;
  loading: boolean;
  error: string;
  retry: () => void;
  busy: boolean;
  add: (kind: "cover" | "gallery", file?: File) => void;
  remove: (item: ProjectMedia) => Promise<unknown>;
  insert: (item: ProjectMedia) => void;
}) {
  const [preview, setPreview] = useState<ProjectMedia | null>(null);
  const [deleting, setDeleting] = useState<ProjectMedia | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const upload = (kind: "cover" | "gallery", label: string, disabled = false) => (
    <label className="file-button" aria-disabled={disabled || busy || loading || !!error}>
      {label}
      <input type="file" aria-label={label} accept="image/png,image/jpeg,image/webp"
        disabled={disabled || busy || loading || !!error}
        onChange={(event) => {
          add(kind, event.currentTarget.files?.[0]);
          event.currentTarget.value = "";
        }} />
    </label>
  );
  const card = (item: ProjectMedia, index: number) => {
    const title = item.kind === "cover" ? "Обложка" : item.kind === "gallery" ? `Скриншот ${index + 1}` : `Изображение ${index + 1}`;
    return <figure key={item.id} className={item.kind === "cover" ? "media-card media-card-cover" : "media-card"}>
      <button type="button" className="media-thumbnail" aria-label={`Открыть: ${title}`} onClick={() => setPreview(item)}>
        <PrivateImage src={item.url} token={token} alt={title} />
      </button>
      <figcaption>
        <div className="media-caption"><strong>{title}</strong><span>{item.width} × {item.height}</span></div>
        <div className="media-actions">
          <button type="button" onClick={() => insert(item)}>В описание</button>
          <button type="button" aria-label={`Удалить: ${title}`} onClick={() => { setDeleteError(""); setDeleting(item); }}>Удалить</button>
        </div>
      </figcaption>
    </figure>;
  };
  const covers = media.filter(item => item.kind === "cover");
  const gallery = media.filter(item => item.kind === "gallery").sort((a, b) => a.position - b.position);
  const description = media.filter(item => item.kind === "description");
  return <div className="project-media-editor">
    <p>PNG, JPEG или WebP до 10 МБ. Изменения опубликованной карточки проходят повторную проверку.</p>
    {loading && <p role="status">Загружаем изображения…</p>}
    {error && <div role="alert"><p>Не удалось загрузить изображения.</p><button onClick={retry}>Повторить</button></div>}
    <section className="media-section">
      <div className="media-section-heading"><div><h3>Обложка карточки</h3><p>Квадратное изображение проекта для каталога.</p></div>
        {upload("cover", covers.length ? "Заменить обложку" : "Загрузить обложку")}
      </div>
      {covers.map(card)}
      {!loading && !error && !covers.length && <p className="media-empty">Обложка ещё не добавлена.</p>}
    </section>
    <section className="media-section">
      <div className="media-section-heading"><div><h3>Скриншоты · {gallery.length} / 8</h3><p>Покажите проект в игре. Нажмите на миниатюру, чтобы рассмотреть изображение.</p></div>
        {upload("gallery", "Добавить скриншот", gallery.length >= 8)}
      </div>
      {!!gallery.length && <div className="project-media-grid">{gallery.map(card)}</div>}
      {!loading && !error && !gallery.length && <p className="media-empty">Скриншотов пока нет.</p>}
      {gallery.length >= 8 && <p>Добавлено 8 скриншотов. Удалите один, чтобы загрузить новый.</p>}
    </section>
    {!!description.length && <section className="media-section">
      <div className="media-section-heading"><div><h3>Изображения описания · {description.length}</h3><p>Загружены через редактор описания и не входят в галерею скриншотов.</p></div></div>
      <div className="project-media-grid">{description.map(card)}</div>
    </section>}
    {preview && <Modal title="Просмотр изображения" close={() => setPreview(null)}>
      <div className="media-full-preview"><PrivateImage token={token} src={preview.url} alt="Изображение проекта" /></div>
      <p>{preview.width} × {preview.height} пикселей</p>
    </Modal>}
    {deleting && <Modal title="Удалить изображение?" close={() => setDeleting(null)} busy={busy}>
      <p>Изображение будет удалено из проекта. Если оно вставлено в описание, ссылку в тексте тоже нужно убрать.</p>
      {deleteError && <p role="alert" className="error-notice">{deleteError}</p>}
      <div className="modal-actions"><button disabled={busy} onClick={() => setDeleting(null)}>Отмена</button>
        <button className="danger" disabled={busy} onClick={() => void remove(deleting).then(() => setDeleting(null)).catch(reason => setDeleteError(String(reason)))}>Удалить изображение</button>
      </div>
    </Modal>}
  </div>;
}
