import { useContentInspector } from "./ContentInspector";

// Accepts local and moderation manifests without assuming that the project is published.
export function ManifestContentLinks({
  manifest,
  parent,
}: {
  manifest: unknown;
  parent: string;
}) {
  const inspect = useContentInspector();
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
  return (
    <div className="manifest-content-links">
      <h3>Состав и связи пакета</h3>
      {rows.map((ref, index) => (
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
    </div>
  );
}
