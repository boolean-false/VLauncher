import { useMemo } from "react";
import { compareSemVer } from "../model";
import {
  makeVersionRequirement,
  nextMinorVersion,
  normalizeVersion,
  parseVersionRequirement,
  versionRequirementExplanation,
  type VersionRequirementMode,
} from "../versionRequirement";
import { Select } from "./Select";

export function VersionRequirementEditor({
  value,
  versions,
  onChange,
}: {
  value: string;
  versions: string[];
  onChange: (value: string) => void;
}) {
  const parsed = parseVersionRequirement(value);
  const knownVersions = useMemo(() => {
    const values = new Set(
      [parsed.minimum, parsed.maximum, ...versions]
        .map((version) => normalizeVersion(version ?? ""))
        .filter(Boolean),
    );
    return [...values].sort((left, right) => compareSemVer(right, left));
  }, [parsed.minimum, parsed.maximum, versions]);
  const minimum = parsed.minimum ?? knownVersions[0] ?? "";
  const suggestedMaximum = nextMinorVersion(minimum);
  const maximum = parsed.maximum ?? suggestedMaximum;

  const setMode = (mode: VersionRequirementMode) => {
    if (mode === "advanced") {
      onChange(minimum ? `^${minimum}` : "");
      return;
    }
    onChange(makeVersionRequirement(mode, minimum, maximum));
  };
  const setMinimum = (version: string) => {
    const mode = parsed.mode === "advanced" || parsed.mode === "any"
      ? "minimum"
      : parsed.mode;
    const upper = mode === "range" && compareSemVer(maximum, version) > 0
      ? maximum
      : nextMinorVersion(version);
    onChange(makeVersionRequirement(mode, version, upper));
  };

  return (
    <section className="version-requirement-editor" aria-label="Совместимость с VoxelCore">
      <div className="version-requirement-heading">
        <div>
          <strong>Какие версии VoxelCore поддерживаются?</strong>
          <span>Лаунчер прочитал начальную версию из зависимости <code>base</code>.</span>
        </div>
        <code>{value || "не выбрано"}</code>
      </div>
      <div className="version-requirement-fields">
        <label>
          Правило совместимости
          <Select
            aria-label="Правило совместимости VoxelCore"
            value={parsed.mode}
            onChange={(event) => setMode(event.target.value as VersionRequirementMode)}
          >
            <option value="minimum">Эта версия и новее</option>
            <option value="exact">Только эта версия</option>
            <option value="range">Диапазон версий</option>
            <option value="any">Любая версия</option>
            <option value="advanced">Расширенное условие</option>
          </Select>
        </label>
        {parsed.mode !== "any" && parsed.mode !== "advanced" && (
          <label>
            {parsed.mode === "range" ? "Начиная с" : "Версия"}
            <Select
              aria-label="Начальная версия VoxelCore"
              value={minimum}
              onChange={(event) => setMinimum(event.target.value)}
            >
              {knownVersions.map((version) => (
                <option key={version} value={version}>{version}</option>
              ))}
            </Select>
          </label>
        )}
        {parsed.mode === "range" && (
          <label>
            До версии, не включая
            <Select
              aria-label="Конечная версия VoxelCore"
              value={maximum}
              onChange={(event) => onChange(makeVersionRequirement("range", minimum, event.target.value))}
            >
              {[...new Set([suggestedMaximum, ...knownVersions])]
                .filter((version) => compareSemVer(version, minimum) > 0)
                .sort((left, right) => compareSemVer(left, right))
                .map((version) => <option key={version} value={version}>{version}</option>)}
            </Select>
          </label>
        )}
      </div>
      <p className="version-requirement-explanation">{versionRequirementExplanation(value)}</p>
      <details className="version-requirement-advanced" open={parsed.mode === "advanced"}>
        <summary>Расширенный режим</summary>
        <label>
          Условие semver
          <input
            aria-label="Расширенное условие semver"
            value={value}
            placeholder=">=0.32.0 <0.33.0"
            spellCheck={false}
            onChange={(event) => onChange(event.target.value)}
          />
        </label>
      </details>
    </section>
  );
}
