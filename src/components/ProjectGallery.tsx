import { useEffect, useState } from "react";
import { Modal } from "./ui";
import { PrivateImage } from "./PrivateImage";

export function ProjectGallery({
  urls,
  title,
}: {
  urls: string[];
  title: string;
}) {
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const index = Math.min(selected, urls.length - 1);
  useEffect(() => {
    if (!expanded) return;
    const move = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      setSelected((current) =>
        Math.max(
          0,
          Math.min(
            urls.length - 1,
            current + (event.key === "ArrowRight" ? 1 : -1),
          ),
        ),
      );
    };
    window.addEventListener("keydown", move);
    return () => window.removeEventListener("keydown", move);
  }, [expanded, urls.length]);
  if (!urls.length) return null;
  const navigation = (
    <div className="project-gallery-navigation">
      <button
        type="button"
        disabled={index === 0}
        onClick={() => setSelected(index - 1)}
        aria-label="Предыдущий скриншот"
      >
        ←
      </button>
      <span aria-live="polite">
        {index + 1} / {urls.length}
      </span>
      <button
        type="button"
        disabled={index === urls.length - 1}
        onClick={() => setSelected(index + 1)}
        aria-label="Следующий скриншот"
      >
        →
      </button>
    </div>
  );
  return (
    <section className="project-screenshots" aria-label="Скриншоты проекта">
      <header>
        <h2>Скриншоты</h2>
        {urls.length > 1 && navigation}
      </header>
      <button
        type="button"
        className="project-screenshot-main"
        onClick={() => setExpanded(true)}
        aria-label={`Открыть скриншот ${index + 1} проекта ${title}`}
      >
        <PrivateImage
          src={urls[index]}
          alt={`Скриншот ${index + 1} проекта ${title}`}
        />
      </button>
      {urls.length > 1 && (
        <div
          className="project-screenshot-thumbnails"
          aria-label="Выбор скриншота"
        >
          {urls.map((url, number) => (
            <button
              type="button"
              key={`${number}:${url}`}
              aria-label={`Показать скриншот ${number + 1}`}
              aria-pressed={index === number}
              onClick={() => setSelected(number)}
            >
              <PrivateImage src={url} alt={`Миниатюра ${number + 1}`} />
            </button>
          ))}
        </div>
      )}
      {expanded && (
        <Modal
          title={`Скриншот ${index + 1} из ${urls.length}`}
          className="catalog-image-dialog"
          close={() => setExpanded(false)}
        >
          <div className="media-full-preview">
            <PrivateImage
              src={urls[index]}
              alt={`Скриншот ${index + 1} проекта ${title}`}
            />
          </div>
          {urls.length > 1 && navigation}
        </Modal>
      )}
    </section>
  );
}
