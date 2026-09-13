export type LauncherFile = {
  id: string;
  kind: string;
  filename: string;
  size: number;
  sha256: string;
};
export type LauncherRelease = {
  id: string;
  version: string;
  channel: string;
  target: string;
  architecture: string;
  status: string;
  notes: string;
  files: LauncherFile[];
};
export const releaseStatus: Record<string, string> = {
  draft: "Черновик",
  published: "Опубликован",
  withdrawn: "Отозван",
  retired: "Архив",
};
export const platformName = (r: LauncherRelease) =>
  `${({ windows: "Windows", linux: "Linux", darwin: "macOS" } as Record<string, string>)[r.target] ?? r.target} · ${r.target === "darwin" ? (r.architecture === "aarch64" ? "Apple Silicon" : r.architecture === "x86_64" ? "Intel" : r.architecture) : r.architecture === "x86_64" ? "x64" : r.architecture}`;
export const filesReady = (r: LauncherRelease) =>
  ["installer", "update"].every((kind) =>
    r.files.some(
      (f) => f.kind === kind && f.size > 0 && /^[a-f0-9]{64}$/i.test(f.sha256),
    ),
  );
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const withoutBuild = v.split("+")[0];
    const dash = withoutBuild.indexOf("-");
    return {
      base: (dash < 0 ? withoutBuild : withoutBuild.slice(0, dash))
        .split(".")
        .map(Number),
      pre: dash < 0 ? [] : withoutBuild.slice(dash + 1).split("."),
    };
  };
  const left = parse(a),
    right = parse(b);
  for (let i = 0; i < 3; i++)
    if (left.base[i] !== right.base[i]) return left.base[i] - right.base[i];
  if (!left.pre.length || !right.pre.length)
    return Number(!left.pre.length) - Number(!right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
export function groupReleases(items: LauncherRelease[]) {
  const groups = new Map<
    string,
    { key: string; version: string; channel: string; builds: LauncherRelease[] }
  >();
  for (const item of items) {
    const key = `${item.version}/${item.channel}`;
    if (!groups.has(key))
      groups.set(key, {
        key,
        version: item.version,
        channel: item.channel,
        builds: [],
      });
    groups.get(key)!.builds.push(item);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        compareVersions(b.version, a.version) ||
        a.channel.localeCompare(b.channel),
    )
    .map((group) => ({
      ...group,
      builds: group.builds.sort(
        (a, b) =>
          ["windows", "linux", "darwin"].indexOf(a.target) -
            ["windows", "linux", "darwin"].indexOf(b.target) ||
          a.architecture.localeCompare(b.architecture),
      ),
    }));
}
export function displayFiles(files: LauncherFile[]) {
  const result: { file: LauncherFile; kinds: string[] }[] = [];
  for (const file of files) {
    const existing = /^[a-f0-9]{64}$/i.test(file.sha256)
      ? result.find(
          (item) =>
            item.file.sha256 === file.sha256 && item.file.size === file.size,
        )
      : undefined;
    if (existing) existing.kinds.push(file.kind);
    else result.push({ file, kinds: [file.kind] });
  }
  return result;
}
