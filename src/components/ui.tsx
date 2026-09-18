import { useEffect, useId, useRef, type ReactNode } from "react";
export type IconName =
  | "library"
  | "catalog"
  | "activity"
  | "workshop"
  | "terminal"
  | "settings"
  | "plus"
  | "play"
  | "folder"
  | "arrow"
  | "close"
  | "search"
  | "package"
  | "world"
  | "check"
  | "download"
  | "more";
const paths: Record<IconName, ReactNode> = {
  library: <><path d="M3 3h18v8H3zM3 13h18v8H3z" /><path d="M7 7h5M7 17h5" /></>,
  catalog: <><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" /><path d="M16.5 16.5h2v2h-2z" fill="currentColor" stroke="none" /></>,
  activity: <><path d="M5 3v18M10 6h11M10 12h8M10 18h11" /><path d="M3 4h4v4H3zM3 10h4v4H3zM3 16h4v4H3z" /></>,
  workshop: <path d="M3 4h14l4 2.5L17 9H3zM9 9h4v12H9z" />,
  terminal: <><path d="M3 4h18v16H3z" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
  settings: <><path d="M3 6h5m6 0h7M3 18h9m6 0h3" /><path d="M8 3h6v6H8zM12 15h6v6h-6z" /></>,
  plus: <path d="M12 4v16M4 12h16" />,
  play: <><path d="M7 4v16l13-8z" /><path d="M3 4v16" /></>,
  folder: <path d="M3 6h7l2 3h9v11H3zM3 12h18" />,
  arrow: <path d="M5 19 19 5M10 5h9v9M5 11v8h8" />,
  close: <path d="M5 5l14 14M5 19 19 5" />,
  search: <><circle cx="10" cy="10" r="7" /><path d="m15 15 6 6" /></>,
  package: <><path d="M6 6h12v12H6zM9 9h6v6H9zM9 2v4m6-4v4M9 18v4m6-4v4M2 9h4m-4 6h4m12-6h4m-4 6h4" /></>,
  world: <><path d="M3 3h18v18H3zM7 7h4v4H7zM13 13h4v4h-4z" /><path d="M11 9h4v6" /></>,
  check: <path d="m4 12 5 5L20 6" />,
  download: <path d="M12 3v12m-5-5 5 5 5-5M3 17v4h18v-4" />,
  more: <path d="M3 10h4v4H3zM10 10h4v4h-4zM17 10h4v4h-4z" fill="currentColor" stroke="none" />,
};
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Modal({
  title,
  children,
  close,
  busy = false,
  closeOnBackdrop = true,
  className,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  busy?: boolean;
  closeOnBackdrop?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={id}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onClick={(e) => {
        if (closeOnBackdrop && e.target === ref.current && !busy) {
          const r = ref.current.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            close();
        }
      }}
    >
      <div className="modal-heading">
        <h2 id={id}>{title}</h2>
        <button
          className="icon-button"
          aria-label="Закрыть"
          disabled={busy}
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  icon = "package",
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-symbol">
        <Icon name={icon} size={28} />
      </div>
      <h2>{title}</h2>
      {children}
    </div>
  );
}
export function ErrorNotice({
  children,
  retry,
}: {
  children: ReactNode;
  retry?: () => void;
}) {
  return (
    <div className="notice error" role="alert">
      <div>{children}</div>
      {retry && <button onClick={retry}>Повторить</button>}
    </div>
  );
}

export function CatalogSkeleton() {
  return (
    <div className="catalog-grid catalog-skeleton" role="status">
      <span className="sr-only">Загрузка каталога</span>
      {Array.from({ length: 6 }, (_, index) => (
        <div className="catalog-card" aria-hidden="true" key={index}>
          <div className="catalog-card-top">
            <span className="skeleton-block skeleton-icon" />
            <span className="skeleton-block skeleton-title" />
          </div>
          <span className="skeleton-block skeleton-description" />
          <footer><span className="skeleton-block skeleton-version" /></footer>
        </div>
      ))}
    </div>
  );
}
