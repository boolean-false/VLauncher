import type { VoxelCoreMainRequirement } from "./api";

type ResolutionError = {
  code?: unknown;
  details?: unknown;
};

export function mainRequirementFromResolutionError(
  reason: unknown,
): VoxelCoreMainRequirement | null {
  if (!reason || typeof reason !== "object") return null;
  const error = reason as ResolutionError;
  if (error.code !== "voxelcore_main_commit_required") return null;
  if (!error.details || typeof error.details !== "object") return null;
  const details = error.details as Record<string, unknown>;
  if (
    typeof details.target_version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(details.target_version) ||
    typeof details.min_commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(details.min_commit)
  ) {
    return null;
  }
  return {
    target_version: details.target_version,
    min_commit: details.min_commit,
  };
}
