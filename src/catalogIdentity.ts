type CatalogProjectIdentity = {
  slug: string;
  title: string;
};

function identityPart(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function catalogProjectKeys(project: CatalogProjectIdentity) {
  return new Set(
    [identityPart(project.slug), identityPart(project.title)].filter(Boolean),
  );
}

export function sameCatalogProject(
  left: CatalogProjectIdentity,
  right: CatalogProjectIdentity,
) {
  const leftKeys = catalogProjectKeys(left);
  return [...catalogProjectKeys(right)].some((key) => leftKeys.has(key));
}
