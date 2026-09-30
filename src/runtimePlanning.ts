import { invoke } from "@tauri-apps/api/core";
import { resolveProject, type SignedInstallPlan } from "./api";
import { mainRuntimeContext, type MainBuild, type Runtime } from "./model";
import { resolveWithBuildFallback } from "./runtimeSelection";

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
  );
  return { plan: result.value, mainBuild: result.build };
}
