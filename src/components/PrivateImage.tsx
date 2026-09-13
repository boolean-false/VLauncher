import { useEffect, useState, type ReactNode } from "react";
import { acquireImage, peekImage } from "../imageCache";
export function PrivateImage({
  src,
  alt,
  token = "",
  fallback,
  className,
}: {
  src: string;
  alt: string;
  token?: string;
  fallback?: ReactNode;
  className?: string;
}) {
  const [state, setState] = useState({
    src,
    token,
    url: peekImage(src, token),
    error: false,
  });
  useEffect(() => {
    let alive = true,
      release: (() => void) | undefined;
    void acquireImage(src, token)
      .then((image) => {
        if (!alive) {
          image.release();
          return;
        }
        release = image.release;
        setState({ src, token, url: image.url, error: false });
      })
      .catch(() => {
        if (alive) setState({ src, token, url: "", error: true });
      });
    const clear = (e: Event) => {
      if ((e as CustomEvent).detail === token) {
        alive = false;
        release?.();
        release = undefined;
        setState({ src, token, url: "", error: true });
      }
    };
    window.addEventListener("image-session-cleared", clear);
    return () => {
      alive = false;
      release?.();
      window.removeEventListener("image-session-cleared", clear);
    };
  }, [src, token]);
  if (state.src !== src || state.token !== token || !state.url)
    return (
      fallback ?? (
        <span role="status">
          {state.error
            ? "Не удалось загрузить изображение"
            : "Загрузка изображения…"}
        </span>
      )
    );
  return (
    <img
      className={className}
      src={state.url}
      alt={alt}
      onError={() => setState({ src, token, url: "", error: true })}
    />
  );
}
