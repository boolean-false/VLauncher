import { isRuntimeCompatibilityError } from "./runtimeSelection.ts";
import {
  compareSemVer,
  engineVersion,
  profileRuntimeContext,
  type LocalProfile,
} from "./model.ts";
import type {
  loadReleases as LoadReleases,
  resolveProject as ResolveProject,
} from "./api";

export async function findContentUpdates(
  profile: LocalProfile,
  loadReleases: typeof LoadReleases,
  resolveProject: typeof ResolveProject,
) {
  const installed = new Map(profile.packages.map((pkg) => [pkg.id, pkg]));
  const installedVersion = (id: string) => {
    const version = installed.get(id)?.version;
    if (!version)
      throw new Error(
        `В профиле отсутствует установленная версия пака «${id}». Проверьте состав профиля.`,
      );
    return version;
  };
  const channels = new Set(["stable"]);
  const newer: Record<string, string> = {};
  const latestAllowed = new Map<string, string>();
  const packages = profile.packages.filter(
    (pkg) => pkg.kind !== "runtime" && !pkg.id.startsWith("__world_"),
  );
  for (let start = 0; start < packages.length; start += 4) {
    await Promise.all(
      packages.slice(start, start + 4).map(async (pkg) => {
        const releases = await loadReleases(pkg.id, engineVersion(profile));
        const current = releases.find((r) => r.version === pkg.version);
        if (current) channels.add(current.channel);
        const latest = releases
          .filter(
            (r) =>
              !r.deprecated &&
              r.download_url &&
              (r.channel === "stable" || r.channel === current?.channel),
          )
          .sort((a, b) => compareSemVer(b.version, a.version))[0];
        latestAllowed.set(
          pkg.id,
          latest && compareSemVer(latest.version, pkg.version) > 0
            ? latest.version
            : pkg.version,
        );
        if (latest && compareSemVer(latest.version, pkg.version) > 0)
          newer[pkg.id] = latest.version;
      }),
    );
  }
  const direct = (id: string) => /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id);
  const requirements = Object.fromEntries(
    profile.roots.map((id) => {
      const current = installedVersion(id);
      const latest = latestAllowed.get(id) ?? current;
      return [id, direct(id) ? `=${latest}` : `>=${current} <=${latest}`];
    }),
  );
  const resolve = () =>
    resolveProject(
      profile.roots,
      engineVersion(profile),
      requirements,
      [...channels],
      {},
      undefined,
      profileRuntimeContext(profile),
    );
  let plan;
  try {
    plan = await resolve();
  } catch (error) {
    if (
      !isRuntimeCompatibilityError(error) ||
      !profile.roots.some((id) => direct(id) && newer[id])
    )
      throw error;
    for (const id of profile.roots.filter(direct))
      requirements[id] = `=${installedVersion(id)}`;
    plan = await resolve();
  }
  const versions: Record<string, string> = {};
  for (const pkg of plan.plan.packages) {
    const old = installed.get(pkg.id);
    if (old && compareSemVer(pkg.version, old.version) > 0)
      versions[pkg.id] = pkg.version;
  }
  return { plan, versions, newer, channels: [...channels] };
}
