import { useLayoutEffect, useEffect, useRef, useState } from "react";
import type { CategoryOption } from "../api";

export function CategoryFilter({
  items,
  value,
  onChange,
}: {
  items: CategoryOption[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const [count, setCount] = useState(items.length);
  const [open, setOpen] = useState(false);
  const toggle = (id: string) =>
    onChange(
      value.includes(id) ? value.filter((x) => x !== id) : [...value, id],
    );
  useLayoutEffect(() => {
    const resize = () => {
      const widths = Array.from(measure.current?.children ?? []).map(
        (x) => x.getBoundingClientRect().width + 6,
      );
      const available = root.current?.clientWidth ?? 0;
      const total = widths.reduce((a, b) => a + b, 0);
      let used = widths[0] ?? 0,
        n = 0;
      for (const width of widths.slice(1)) {
        if (used + width > available - (total > available ? 140 : 0)) break;
        used += width;
        n++;
      }
      setCount(n);
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [items]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        more.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  useEffect(() => setOpen(false), [items]);
  const hidden = items.slice(count);
  return (
    <div ref={root} className="category-filter">
      <div className="category-measure-clip" aria-hidden="true">
        <div className="category-tabs category-measure" ref={measure}>
          <span>Все</span>
          {items.map((item) => (
            <span key={item.id}>{item.name}</span>
          ))}
        </div>
      </div>
      <div className="category-tabs category-line">
        <button
          aria-pressed={!value.length}
          className={!value.length ? "active" : ""}
          onClick={() => onChange([])}
        >
          Все
        </button>
        {items.slice(0, count).map((item) => (
          <button
            key={item.id}
            aria-pressed={value.includes(item.id)}
            className={value.includes(item.id) ? "active" : ""}
            onClick={() => toggle(item.id)}
          >
            {item.name}
          </button>
        ))}
        {!!hidden.length && (
          <button
            ref={more}
            aria-expanded={open}
            aria-controls="more-categories"
            onClick={() => setOpen(!open)}
          >
            Ещё ({hidden.length})
            {hidden.some((x) => value.includes(x.id)) ? " •" : ""}
          </button>
        )}
      </div>
      {!!value.length && (
        <div className="category-selection">
          <span>
            Все выбранные:{" "}
            {items
              .filter((x) => value.includes(x.id))
              .map((x) => x.name)
              .join(" · ")}
          </span>
          <button onClick={() => onChange([])}>Сбросить</button>
        </div>
      )}
      {open && !!hidden.length && (
        <div
          id="more-categories"
          className="category-popover"
          style={{
            maxHeight: Math.max(
              100,
              window.innerHeight -
                (root.current?.getBoundingClientRect().top ?? 0) -
                90,
            ),
            right: Math.max(
              0,
              (root.current?.clientWidth ?? 0) -
                (more.current?.offsetLeft ?? 0) -
                (more.current?.offsetWidth ?? 0),
            ),
          }}
          aria-label="Другие категории"
          onBlur={(event) => {
            if (!root.current?.contains(event.relatedTarget as Node))
              setOpen(false);
          }}
        >
          <p>Можно выбрать несколько</p>
          {hidden.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={value.includes(item.id)}
                onChange={() => toggle(item.id)}
              />
              {item.name}
            </label>
          ))}
          <button
            onClick={() => {
              setOpen(false);
              more.current?.focus();
            }}
          >
            Готово
          </button>
        </div>
      )}
    </div>
  );
}
