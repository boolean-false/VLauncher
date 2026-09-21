import { loadProject, loadReleases, resolveProject } from "./api";
import { markdownImage } from "./markdownImage";

export type ContentRef = {
  source: string;
  slug: string;
  title?: string;
  version?: string;
  versionId?: number;
  requirement?: string;
  relation?: string;
  parent?: string;
  engine?: string;
};
export type ContentInfo = {
  title: string;
  description: string;
  iconUrl?: string;
  type?: "mod" | "modpack" | "project" | "world" | "runtime";
  version?: string;
  note?: string;
  versions?: string[];
  dependencies: ContentRef[];
};
export type ContentSource = {
  label: string;
  load: (ref: ContentRef) => Promise<ContentInfo>;
};
export const vspaceContentSource: ContentSource = {
  label: "VSpace",
  async load(ref) {
    const project = await loadProject(ref.slug);
    const releases = await loadReleases(ref.slug);
    let exact =
      ref.version ||
      (ref.requirement?.startsWith("=") ? ref.requirement.slice(1) : undefined);
    let resolutionNote: string | undefined;
    if (
      !exact &&
      ref.requirement &&
      ref.engine &&
      ref.relation !== "conflict"
    ) {
      try {
        const plan = await resolveProject(
          [ref.slug],
          ref.engine,
          { [ref.slug]: ref.requirement },
          ["stable", "beta", "alpha"],
        );
        exact = plan.plan.packages.find(
          (item) => item.id === ref.slug,
        )?.version;
        resolutionNote =
          "Версия подобрана для просмотра под VoxelCore. Итоговый состав проверяется вместе со всеми пакетами профиля.";
      } catch {
        resolutionNote =
          "Не удалось подобрать версию для этого требования. Описание проекта доступно ниже.";
      }
    }
    // A range is not a resolved version. Never show the latest release's dependencies as its result.
    const release = exact
      ? releases.find((item) => item.version === exact)
      : ref.requirement
        ? undefined
        : (releases.find(
            (item) => item.channel === "stable" && !item.deprecated,
          ) ?? releases[0]);
    return {
      title: project.title,
      description: project.description || project.summary,
      iconUrl:
        project.cover_url ||
        project.latest_release?.preview_url ||
        markdownImage(project.description),
      type: project.type,
      version: release?.version,
      versions: releases.map((item) => item.version),
      note: !release
        ? exact
          ? `Релиз ${exact} недоступен. Показано описание проекта.`
          : resolutionNote ||
            "Точная версия будет выбрана при проверке состава. Зависимости зависят от выбранной версии."
        : resolutionNote,
      dependencies: (release?.dependencies ?? []).map((item) => ({
        source: "vspace",
        slug: item.id,
        requirement: item.requirement,
        relation: item.kind,
        parent: project.title,
        engine: ref.engine,
      })),
    };
  },
};
