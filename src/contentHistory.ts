import type { ContentRef } from "./contentView";

export const contentIdentity = (ref: ContentRef) =>
  JSON.stringify([
    ref.source,
    ref.slug,
    ref.version,
    ref.versionId,
    ref.requirement,
    ref.engine,
  ]);
export function visitContent(
  history: ContentRef[],
  ref: ContentRef,
): ContentRef[] {
  const index = history.findIndex(
    (item) => contentIdentity(item) === contentIdentity(ref),
  );
  return index < 0 ? [...history, ref] : history.slice(0, index + 1);
}
