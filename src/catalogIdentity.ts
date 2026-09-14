type CatalogProjectIdentity = {
  slug: string;
  title: string;
  package_id?: string | null;
};

function identityPart(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function catalogProjectKeys(project: CatalogProjectIdentity) {
  return new Set(
    [project.package_id, project.slug, project.title]
      .filter((value): value is string => !!value)
      .map(identityPart)
      .filter(Boolean),
  );
}

export function sameCatalogProject(
  left: CatalogProjectIdentity,
  right: CatalogProjectIdentity,
) {
  const leftKeys = catalogProjectKeys(left);
  return [...catalogProjectKeys(right)].some((key) => leftKeys.has(key));
}
