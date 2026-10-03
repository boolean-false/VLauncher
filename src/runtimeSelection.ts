import type { MainBuild } from "./model";
import { mainRequirementFromResolutionError } from "./resolutionRequirement.ts";
import { normalizeVersion } from "./versionRequirement.ts";

export function isRuntimeCompatibilityError(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return (
    code === "voxelcore_main_commit_required" ||
    code === "no_compatible_release" ||
    code === "package_conflict" ||
    code === "dependency_cycle"
  );
}

/** A version number alone cannot establish main-build compatibility. Verify the entire plan. */
export async function selectVerifiedBuild<T>(
  builds: MainBuild[],
  verify: (build: MainBuild) => Promise<T>,
): Promise<{ value: T; build: MainBuild }> {
  for (const build of [...builds].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  )) {
    try {
      return { value: await verify(build), build };
    } catch (error) {
      // Transport/authentication errors must not be presented as missing compatible builds.
      if (!isRuntimeCompatibilityError(error)) throw error;
    }
  }
  throw new Error(
    "Подходящая DEV-сборка пока недоступна для вашей системы. Доступные сборки не удовлетворяют требованиям выбранного содержимого. Повторите проверку позже или выберите другую версию мода.",
  );
}

export async function resolveWithBuildFallback<T>(
  initial: () => Promise<T>,
  loadBuilds: () => Promise<MainBuild[]>,
  verify: (build: MainBuild) => Promise<T>,
  tryStable?: () => Promise<{ value: T } | undefined>,
): Promise<{ value: T; build?: MainBuild }> {
  try {
    return { value: await initial() };
  } catch (error) {
    let requirement = mainRequirementFromResolutionError(error);
    if (tryStable && isRuntimeCompatibilityError(error)) {
      try {
        const stable = await tryStable();
        if (stable) return stable;
      } catch (reason) {
        if (!isRuntimeCompatibilityError(reason)) throw reason;
        requirement = mainRequirementFromResolutionError(reason) ?? requirement;
      }
    }
    if (!requirement) throw error;
    const builds = await loadBuilds();
    return selectVerifiedBuild(
      builds.filter(
        (build) =>
          normalizeVersion(build.engine_version ?? "") ===
          normalizeVersion(requirement.target_version),
      ),
      verify,
    );
  }
}
