import type { Release, VoxelCoreMainRequirement } from "./api";
import { compareSemVer } from "./model.ts";
import { normalizeVersion } from "./versionRequirement.ts";

export function previousReleaseMainRequirement(
  releases: Release[],
  targetVersion: string,
  latestStableVersion: string,
): VoxelCoreMainRequirement | null {
  const previous = releases[0];
  const requirement =
    previous?.effective_voxelcore_main ??
    previous?.attestation?.assertion?.manifest?.voxelcore_main;
  const target = normalizeVersion(targetVersion);
  const stable = normalizeVersion(latestStableVersion);
  if (
    !requirement ||
    !target ||
    !stable ||
    compareSemVer(target, stable) <= 0 ||
    normalizeVersion(requirement.target_version) !== target ||
    !/^[a-f0-9]{40}$/.test(requirement.min_commit)
  ) {
    return null;
  }
  return { target_version: target, min_commit: requirement.min_commit };
}
