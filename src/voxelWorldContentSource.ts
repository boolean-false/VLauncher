import { invoke } from "@tauri-apps/api/core";
import { readJointCatalogEnabled } from "./experimental";
import type { ContentSource } from "./contentView";
import type { VoxelWorldMod, VoxelWorldVersion } from "./voxelWorld";

export const voxelWorldContentSource: ContentSource = {
  label: "VoxelWorld",
  async load(ref) {
    if (!readJointCatalogEnabled())
      throw new Error("Интеграция VoxelWorld выключена.");
    const request = async <T>(path: string) =>
      (await invoke<{ data: T }>("voxelworld_request", { path, query: "" }))
        .data;
    const project = await request<VoxelWorldMod>(
      `mods/${encodeURIComponent(ref.slug)}`,
    );
    const release = ref.versionId
      ? await request<VoxelWorldVersion>(
          `mods/${encodeURIComponent(ref.slug)}/versions/${ref.versionId}`,
        )
      : undefined;
    return {
      title: project.title,
      description: project.detail_description || project.description,
      iconUrl: project.logo_url || undefined,
      type: "mod",
      version: release?.version_number,
      note: !release
        ? "Точная версия не указана. Показано описание проекта."
        : undefined,
      dependencies: (release?.dependencies ?? []).map((dep) => ({
        source: "voxelworld",
        slug: dep.project.slug,
        title: dep.project.title,
        version: dep.version_number,
        versionId: dep.id,
        relation: "required",
        parent: project.title,
      })),
    };
  },
};
