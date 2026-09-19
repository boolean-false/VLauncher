export type VersionRequirementMode =
  | "minimum"
  | "exact"
  | "range"
  | "any"
  | "advanced";

const VERSION = /^(?:v)?(\d+)(?:\.(\d+))?(?:\.(\d+))?((?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

export function normalizeVersion(value: string): string {
  const match = value.trim().match(VERSION);
  if (!match) return "";
  return `${match[1]}.${match[2] ?? "0"}.${match[3] ?? "0"}${match[4] ?? ""}`;
}

export function nextMinorVersion(value: string): string {
  const normalized = normalizeVersion(value);
  const match = normalized.match(/^(\d+)\.(\d+)\.\d+/);
  return match ? `${match[1]}.${Number(match[2]) + 1}.0` : "";
}

export type ParsedVersionRequirement = {
  mode: VersionRequirementMode;
  minimum?: string;
  maximum?: string;
};

export function parseVersionRequirement(value: string): ParsedVersionRequirement {
  const requirement = value.trim();
  if (requirement === "*") return { mode: "any" };

  const range = requirement.match(/^>=\s*([^,\s]+)\s+<\s*([^,\s]+)$/);
  if (range) {
    const minimum = normalizeVersion(range[1]);
    const maximum = normalizeVersion(range[2]);
    if (minimum && maximum) return { mode: "range", minimum, maximum };
  }

  const minimum = requirement.match(/^>=\s*(\S+)$/);
  if (minimum) {
    const version = normalizeVersion(minimum[1]);
    if (version) return { mode: "minimum", minimum: version };
  }

  const exact = requirement.match(/^=?\s*(\S+)$/);
  if (exact) {
    const version = normalizeVersion(exact[1]);
    if (version) return { mode: "exact", minimum: version };
  }

  return { mode: "advanced" };
}

export function makeVersionRequirement(
  mode: Exclude<VersionRequirementMode, "advanced">,
  minimum = "",
  maximum = "",
): string {
  if (mode === "any") return "*";
  const normalizedMinimum = normalizeVersion(minimum);
  if (!normalizedMinimum) return "";
  if (mode === "exact") return `=${normalizedMinimum}`;
  if (mode === "minimum") return `>=${normalizedMinimum}`;
  const normalizedMaximum = normalizeVersion(maximum);
  return normalizedMaximum
    ? `>=${normalizedMinimum} <${normalizedMaximum}`
    : "";
}

export function normalizeVersionRequirement(value: string): string {
  const parsed = parseVersionRequirement(value);
  if (parsed.mode === "advanced") return value.trim();
  return makeVersionRequirement(
    parsed.mode,
    parsed.minimum,
    parsed.maximum,
  );
}

export function versionRequirementExplanation(value: string): string {
  const parsed = parseVersionRequirement(value);
  if (parsed.mode === "any") return "Подходит любая версия VoxelCore.";
  if (parsed.mode === "exact") return `Подходит только VoxelCore ${parsed.minimum}.`;
  if (parsed.mode === "minimum") return `Подходит VoxelCore ${parsed.minimum} и все более новые версии.`;
  if (parsed.mode === "range") {
    return `Подходит VoxelCore от ${parsed.minimum} включительно до ${parsed.maximum}, не включая её.`;
  }
  return value.trim()
    ? "Используется расширенное условие semver. Оно будет дополнительно проверено сервером."
    : "Выберите поддерживаемые версии VoxelCore.";
}

export function isVersionRequirementValid(value: string): boolean {
  const parsed = parseVersionRequirement(value);
  if (parsed.mode !== "advanced") return true;
  const requirement = value.trim();
  if (!requirement) return false;
  // Mirrors the common npm-semver forms accepted by the registry. A comma is
  // deliberately rejected: npm ranges join comparators with whitespace.
  const version = String.raw`v?\d+(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`;
  const comparator = String.raw`(?:>=|<=|>|<|=|~|\^)?\s*${version}`;
  const clause = new RegExp(String.raw`^${comparator}(?:\s+${comparator})*$`);
  return requirement.split(/\s*\|\|\s*/).every((part) => clause.test(part.trim()));
}
