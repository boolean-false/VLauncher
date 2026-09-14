import { useState } from "react";
import { useContentInspector } from "./ContentInspector";

// Accepts local and moderation manifests without assuming that the project is published.
export function ManifestContentLinks({
  manifest,
  parent,
  compact = false,
}: {
  manifest: unknown;
  parent: string;
  compact?: boolean;
}) {
  const inspect = useContentInspector();
  const [query, setQuery] = useState("");
  if (!manifest || typeof manifest !== "object") return null;
  const data = manifest as Record<string, unknown>;
  const rows = ["dependencies", "conflicts", "external_packages"].flatMap(
    (group) => {
      const items = data[group];
      if (!Array.isArray(items)) return [];
      return items.flatMap((item: unknown) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        if (typeof value.id !== "string") return [];
        return [
          {
            source: typeof value.source === "string" ? value.source : "vspace",
            slug: typeof value.slug === "string" ? value.slug : value.id,
            title: typeof value.title === "string" ? value.title : value.id,
            version:
              typeof value.version === "string" ? value.version : undefined,
            versionId:
              typeof value.version_id === "number"
                ? value.version_id
                : undefined,
            requirement:
              typeof value.requirement === "string"
                ? value.requirement
                : undefined,
            relation:
              group === "conflicts"
                ? "conflict"
                : typeof value.kind === "string"
                  ? value.kind
                  : "required",
            parent,
          },
        ];
      });
    },
  );
  if (!rows.length) return null;

  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const visibleRows = normalizedQuery
    ? rows.filter((row) =>
        [row.title, row.slug, row.source, row.version, row.requirement]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase("ru").includes(normalizedQuery)),
      )
    : rows;

  const list = (
    <div className={compact ? "manifest-content-scroll" : undefined}>
      {visibleRows.map((ref, index) => (
        <button
          key={`${ref.source}:${ref.slug}:${index}`}
          className="inspector-dependency"
          onClick={() => inspect(ref)}
        >
          <strong>{ref.title}</strong>
          <span>{ref.version || ref.requirement}</span>
          <small>
            {ref.source} ·{" "}
            {ref.relation === "conflict" ? "Конфликт" : "Связанный пакет"}
          </small>
        </button>
      ))}
      {!visibleRows.length && (
        <p className="manifest-content-empty">Ничего не найдено</p>
      )}
    </div>
  );

  if (compact) {
    return (
      <details className="manifest-content-links manifest-content-compact">
        <summary>
          <span>Состав сборки</span>
          <small>{rows.length} пакетов</small>
        </summary>
        {rows.length > 10 && (
          <input
            aria-label="Поиск по составу сборки"
            type="search"
            placeholder="Найти пакет…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        {list}
      </details>
    );
  }

  return (
    <div className="manifest-content-links">
      <h3>Состав и связи пакета</h3>
      {list}
    </div>
  );
}
