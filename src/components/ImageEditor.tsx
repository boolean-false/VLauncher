import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./ui";

export function ImageEditor({
  file,
  cover = false,
  onSave,
  close,
}: {
  file: File;
  cover?: boolean;
  onSave: (file: File) => Promise<void>;
  close: () => void;
}) {
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ratio, setRatio] = useState(cover ? "square" : "original");
  const [turn, setTurn] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(0.5),
    [y, setY] = useState(0.5);
  const [pixel, setPixel] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(
    null,
  );
  useEffect(() => {
    if (file.size > 10 * 1024 * 1024) {
      setError("Выберите изображение до 10 МБ.");
      return;
    }
    const url = URL.createObjectURL(file);
    let disposed = false;
    const image = new Image();
    image.src = url;
    void image
      .decode()
      .then(() => {
        if (disposed) return;
        if (image.naturalWidth * image.naturalHeight > 24_000_000) {
          setError("Изображение слишком большое: максимум 24 мегапикселя.");
          return;
        }
        setSource(image);
        setPixel(Math.max(image.naturalWidth, image.naturalHeight) <= 256);
      })
      .catch(() => {
        if (!disposed)
          setError(
            "Не удалось прочитать изображение. Выберите PNG, JPEG или WebP.",
          );
      });
    return () => {
      disposed = true;
      URL.revokeObjectURL(url);
    };
  }, [file]);
  const rotated = useMemo(() => {
    if (!source) return null;
    const c = document.createElement("canvas");
    c.width = turn % 2 ? source.naturalHeight : source.naturalWidth;
    c.height = turn % 2 ? source.naturalWidth : source.naturalHeight;
    const ctx = c.getContext("2d")!;
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((turn * Math.PI) / 2);
    ctx.drawImage(source, -source.naturalWidth / 2, -source.naturalHeight / 2);
    return c;
  }, [source, turn]);
  const crop = useMemo(() => {
    if (!rotated) return null;
    const r =
      cover || ratio === "square"
        ? 1
        : ratio === "wide"
          ? 16 / 9
          : rotated.width / rotated.height;
    const w = Math.min(rotated.width, rotated.height * r) / zoom,
      h = w / r;
    const scale = Math.min(1, 2560 / Math.max(w, h));
    return {
      x: (rotated.width - w) * x,
      y: (rotated.height - h) * y,
      w,
      h,
      width: Math.max(1, Math.round(w * scale)),
      height: Math.max(1, Math.round(h * scale)),
    };
  }, [rotated, ratio, zoom, x, y, cover]);
  useEffect(() => {
    if (!rotated || !crop || !canvas.current) return;
    const c = canvas.current;
    c.width = crop.width;
    c.height = crop.height;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = !pixel;
    ctx.drawImage(
      rotated,
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      0,
      0,
      c.width,
      c.height,
    );
  }, [rotated, crop, pixel]);
  const reset = () => {
    setZoom(1);
    setX(0.5);
    setY(0.5);
  };
  return (
    <Modal title="Подготовить изображение" close={close} busy={busy} closeOnBackdrop={false}>
      <div className="image-editor">
        <p>
          {file.name}
          {source && ` · ${source.naturalWidth} × ${source.naturalHeight}`}
        </p>
        {error && (
          <p className="error-notice" role="alert">
            {error}
          </p>
        )}
        {!source && !error && <p role="status">Открываем изображение…</p>}
        {source && (
          <>
            <div className="image-crop-preview">
              <canvas
                ref={canvas}
                aria-label="Предпросмотр кадрирования"
                style={{
                  imageRendering: pixel ? "pixelated" : "auto",
                  width: crop
                    ? `min(100%, ${(280 * crop.width) / crop.height}px)`
                    : undefined,
                  height: "auto",
                }}
                onPointerDown={(e) => {
                  if (busy) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  drag.current = { x: e.clientX, y: e.clientY, px: x, py: y };
                }}
                onPointerUp={() => {
                  drag.current = null;
                }}
                onPointerCancel={() => {
                  drag.current = null;
                }}
                onPointerMove={(e) => {
                  if (!drag.current || !crop || !rotated) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (rotated.width > crop.w)
                    setX(
                      Math.max(
                        0,
                        Math.min(
                          1,
                          drag.current.px -
                            (((e.clientX - drag.current.x) / rect.width) *
                              crop.w) /
                              (rotated.width - crop.w),
                        ),
                      ),
                    );
                  if (rotated.height > crop.h)
                    setY(
                      Math.max(
                        0,
                        Math.min(
                          1,
                          drag.current.py -
                            (((e.clientY - drag.current.y) / rect.height) *
                              crop.h) /
                              (rotated.height - crop.h),
                        ),
                      ),
                    );
                }}
              />
            </div>
            <fieldset disabled={busy} className="image-editor-controls">
              {cover ? <p>Обложка пака · квадрат 1:1. Переместите изображение, чтобы выбрать нужную область.</p> : <div className="actions" aria-label="Форма кадра">
                {[
                  ["original", "Исходные пропорции"],
                  ["square", "Квадрат"],
                  ["wide", "16:9"],
                ].map(([id, name]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={ratio === id}
                    onClick={() => {
                      setRatio(id);
                      reset();
                    }}
                  >
                    {name}
                  </button>
                ))}
              </div>}
              <label>
                Масштаб · {zoom.toFixed(1)}×
                <input
                  type="range"
                  min="1"
                  max="4"
                  step="0.05"
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
              </label>
              <div className="image-position-controls">
                <label>
                  По горизонтали
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={x}
                    onChange={(e) => setX(Number(e.target.value))}
                  />
                </label>
                <label>
                  По вертикали
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={y}
                    onChange={(e) => setY(Number(e.target.value))}
                  />
                </label>
              </div>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => {
                    setTurn((turn + 1) % 4);
                    reset();
                  }}
                >
                  Повернуть на 90°
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTurn(0);
                    setRatio(cover ? "square" : "original");
                    reset();
                  }}
                >
                  Сбросить
                </button>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={pixel}
                  onChange={(e) => setPixel(e.target.checked)}
                />
                Пиксельная графика - без сглаживания
              </label>
            </fieldset>
            <p className="image-output-size">
              Результат: {crop?.width} × {crop?.height} пикселей. Маленькие
              изображения можно загрузить без увеличения.
            </p>
          </>
        )}
        <div className="modal-actions">
          <button disabled={busy} onClick={close}>
            Отмена
          </button>
          <button
            className="primary"
            disabled={busy || !source}
            onClick={() =>
              void (async () => {
                setBusy(true);
                setError("");
                try {
                  const encode = (c: HTMLCanvasElement, type: string) =>
                    new Promise<Blob>((resolve, reject) =>
                      c.toBlob(b => b ? resolve(b) : reject(new Error("Не удалось обработать изображение")), type, .92),
                    );
                  let output = canvas.current!;
                  let blob = await encode(output, "image/png");
                  if (blob.size > 10 * 1024 * 1024) blob = await encode(output, "image/webp");
                  while (blob.size > 10 * 1024 * 1024) {
                    const smaller = document.createElement("canvas");
                    smaller.width = Math.max(1, Math.floor(output.width * .75));
                    smaller.height = Math.max(1, Math.floor(output.height * .75));
                    const context = smaller.getContext("2d")!;
                    context.imageSmoothingEnabled = !pixel;
                    context.drawImage(output, 0, 0, smaller.width, smaller.height);
                    output = smaller;
                    blob = await encode(output, "image/webp");
                  }
                  await onSave(
                    new File([blob], blob.type === "image/webp" ? "image.webp" : "image.png", { type: blob.type }),
                  );
                  close();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              })()
            }
          >
            {busy ? "Загружаем…" : "Сохранить изображение"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
