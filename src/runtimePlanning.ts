import { invoke } from "@tauri-apps/api/core";
import { resolveProject, type SignedInstallPlan } from "./api";
import {
  compareSemVer,
  mainRuntimeContext,
  type MainBuild,
  type Runtime,
} from "./model";
import {
  isRuntimeCompatibilityError,
  resolveWithBuildFallback,
} from "./runtimeSelection";
import { mainRequirementFromResolutionError } from "./resolutionRequirement";

export type MainCatalog = { head_sha: string; builds: MainBuild[] };
export const loadMainBuilds = () => invoke<MainCatalog>("list_mainline_builds");
export async function prepareMainBuild(build: MainBuild, runtimes: Runtime[]) {
  if (
    !runtimes.some(
      (runtime) => runtime.main_build?.artifact_id === build.artifact_id,
    )
  ) {
    await invoke("install_mainline_build", { build });
  }
}

export async function resolveWithCompatibleRuntime(
  ...args: Parameters<typeof resolveProject>
): Promise<{ plan: SignedInstallPlan; mainBuild?: MainBuild }> {
  const result = await resolveWithBuildFallback(
    () => resolveProject(...args),
    async () => (await loadMainBuilds()).builds,
    (build) =>
      resolveProject(
        args[0],
        build.engine_version!,
        args[2],
        args[3],
        args[4],
        args[5],
        mainRuntimeContext(build),
      ),
    async () => {
      const releases = await invoke<{ version: string; channel: string }[]>(
        "list_official_runtimes",
      );
      const versions = [
        ...new Set(
          releases
            .filter(
              (release) =>
                release.channel === "stable" &&
                compareSemVer(release.version, args[1]) >= 0,
            )
            .map((release) => release.version),
        ),
      ].sort((a, b) => compareSemVer(b, a));
      let gated: unknown;
      for (const version of versions) {
        try {
          return {
            value: await resolveProject(
              args[0],
              version,
              args[2],
              args[3],
              args[4],
              args[5],
              { kind: "stable", version },
            ),
          };
        } catch (error) {
          if (!isRuntimeCompatibilityError(error)) throw error;
          if (!gated && mainRequirementFromResolutionError(error))
            gated = error;
        }
      }
      if (gated) throw gated;
      return undefined;
    },
  );
  return { plan: result.value, mainBuild: result.build };
}
