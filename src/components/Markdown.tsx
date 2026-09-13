import { Modal } from "./ui";
import { ImageEditor } from "./ImageEditor";
import { useId, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { registryMediaUrl } from "../mediaUrl";
import { registryUrl } from "../api";
import { PrivateImage } from "./PrivateImage";

export function Markdown({ text, token }: { text: string; token?: string }) {
  const [error, setError] = useState("");
  return (
    <div className="markdown-body selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^(https?:|mailto:)/i.test(href))
                  void openUrl(href).catch(() =>
                    setError("Не удалось открыть ссылку."),
                  );
              }}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) => {
            if (!src) return null;
            const own = registryMediaUrl(src, registryUrl);
            return own ? (
              <PrivateImage src={own} alt={alt ?? ""} token={token} />
            ) : (
              <img
                src={src}
                alt={alt ?? ""}
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            );
          },
        }}
      >
        {text || "Описание пока не добавлено."}
      </ReactMarkdown>
      {error && <p role="status">{error}</p>}
    </div>
  );
}
export function MarkdownEditor({
  value,
  onChange,
  label = "Описание проекта",
  token,
  onUploadImage,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  token?: string;
  onUploadImage?: (file: File) => Promise<string>;
}) {
  const [preview, setPreview] = useState(false);
  const [chooseImage, setChooseImage] = useState(false);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imageAlt, setImageAlt] = useState("");
  const selection = useRef({ start: 0, end: 0 });
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const insert = (before: string, after = "", fallback = "текст") => {
    const field = input.current;
    if (!field) return;
    const start = field.selectionStart,
      end = field.selectionEnd;
    const selection = value.slice(start, end) || fallback;
    onChange(
      value.slice(0, start) + before + selection + after + value.slice(end),
    );
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(
        start + before.length,
        start + before.length + selection.length,
      );
    });
  };
  const rememberSelection = () => {
    selection.current = {
      start: input.current?.selectionStart ?? value.length,
      end: input.current?.selectionEnd ?? value.length,
    };
  };
  const insertImage = (url: string) => {
    const { start, end } = selection.current;
    const alt = (imageAlt || "Изображение").replace(/[\[\]\n\r]/g, " ");
    const text = `\n\n![${alt}](<${url.replace(/>/g, "%3E")}>)\n\n`;
    onChange(value.slice(0, start) + text + value.slice(end));
    setChooseImage(false);
    setImageUrl("");
    setImageAlt("");
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(
        start + text.length,
        start + text.length,
      );
    });
  };
  return (
    <section className="markdown-editor" aria-label={label}>
      {chooseImage && !imageFile && (
        <Modal
          title="Изображение в описании"
          close={() => setChooseImage(false)}
        >
          <label>
            Подпись изображения
            <input
              value={imageAlt}
              onChange={(e) => setImageAlt(e.target.value)}
              placeholder="Что изображено на картинке"
            />
          </label>
          <label className="file-button">
            Выбрать файл
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={!onUploadImage}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) setImageFile(file);
                e.target.value = "";
              }}
            />
          </label>
          <p>
            {onUploadImage
              ? "Откроется редактор. Картинка сохранится на сервере отдельно от скриншотов проекта."
              : "Загрузка файлов будет доступна после создания проекта. Сейчас можно вставить ссылку."}
          </p>
          <label>
            Или ссылка на изображение
            <input
              type="url"
              placeholder="https://…"
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
            />
          </label>
          <div className="modal-actions">
            <button onClick={() => setChooseImage(false)}>Отмена</button>
            <button
              className="primary"
              disabled={!/^https?:\/\/[^\s<>]+$/i.test(imageUrl.trim())}
              onClick={() => insertImage(imageUrl.trim())}
            >
              Вставить ссылку
            </button>
          </div>
        </Modal>
      )}
      {imageFile && onUploadImage && (
        <ImageEditor
          file={imageFile}
          close={() => setImageFile(null)}
          onSave={async (file) => {
            insertImage(await onUploadImage(file));
          }}
        />
      )}

      <div className="markdown-editor-header">
        <label htmlFor={id}>{label}</label>
        <div role="tablist" aria-label={"Режим: " + label}>
          <button
            type="button"
            role="tab"
            aria-selected={!preview}
            onClick={() => setPreview(false)}
          >
            Редактирование
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={preview}
            onClick={() => setPreview(true)}
          >
            Просмотр
          </button>
        </div>
      </div>
      {!preview && (
        <div className="markdown-tools" aria-label="Форматирование">
          <button
            type="button"
            onClick={() => {
              rememberSelection();
              setChooseImage(true);
            }}
          >
            Изображение
          </button>
          <button type="button" onClick={() => insert("## ", "", "Заголовок")}>
            Заголовок
          </button>
          <button type="button" onClick={() => insert("**", "**")}>
            <b>Жирный</b>
          </button>
          <button type="button" onClick={() => insert("*", "*")}>
            <i>Курсив</i>
          </button>
          <button
            type="button"
            onClick={() => insert("\n- ", "", "Пункт списка")}
          >
            Список
          </button>
          <button
            type="button"
            onClick={() =>
              insert("[", "](https://example.com)", "Название ссылки")
            }
          >
            Ссылка
          </button>
          <button
            type="button"
            onClick={() => insert("\n```lua\n", "\n```\n", "-- код")}
          >
            Код
          </button>
        </div>
      )}
      <div
        role="tabpanel"
        aria-label={preview ? "Просмотр описания" : "Редактирование описания"}
      >
        {preview ? (
          <Markdown text={value} token={token} />
        ) : (
          <textarea
            id={id}
            ref={input}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={
              "## О контент-паке\n\nЧто он добавляет и как им пользоваться?\n\n- Возможности\n- Требования\n- Начало работы"
            }
            onPaste={(event) => {
              const file = Array.from(event.clipboardData.files).find((f) =>
                f.type.startsWith("image/"),
              );
              if (file && onUploadImage) {
                event.preventDefault();
                rememberSelection();
                setImageFile(file);
              }
            }}
            spellCheck
          />
        )}
      </div>
      <small className="markdown-hint">
        Markdown: **жирный**, *курсив*, списки, таблицы и блоки кода.
        Изображения: кнопка «Изображение» или вставка файла из буфера обмена.
      </small>
    </section>
  );
}
