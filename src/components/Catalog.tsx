import { recordContent } from "../telemetry";
import { useContentInspector } from "./ContentInspector";
import { PrivateImage } from "./PrivateImage";
import { useRegistryResource } from "../useResource";
import { CatalogSkeleton } from "./ui";
import { CategoryFilter } from "./CategoryFilter";
import { Markdown } from "./Markdown";
import { markdownImage } from "../markdownImage";
import { popupMenu, contextMenuPosition } from "../desktop";
import { Select } from "./Select";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  type CategoryOption,
  createReport,
  resolveProject,
  type Project,
  type ProjectDetail,
  type Release,
  type SignedInstallPlan,
  type VoxelCoreMainRequirement,
} from "../api";
import {
  engineVersion,
  exactVoxelCoreVersion,
  formatVoxelCoreVersion,
  formatBytes,
  friendlyError,
  kinds,
  compareSemVer,
  mainBuildLabel,
  mainRuntimeContext,
  isProjectProfile,
  profileRuntimeContext,
  type LocalProfile,
  type MainBuild,
  type RunTask,
  type Task,
} from "../model";
import { Empty, ErrorNotice, Icon, Modal } from "./ui";
import { useJointCatalogEnabled } from "../experimental";
import { catalogProjectKeys } from "../catalogIdentity";
import { isVoxelCoreBuiltin } from "../builtinContent";
import { useLatestPublishedVoxelCoreVersion, usePublishedVoxelCoreVersions, useVoxelCoreVersionLabel } from "../VoxelCoreVersionContext";
import { normalizeVersionRequirement, parseVersionRequirement } from "../versionRequirement";
import { mainRequirementFromResolutionError } from "../resolutionRequirement";
import { useMainlineStatus } from "./Mainline";
import {
  mergeModCategories,
  useAllRegistryProjects,
  useVoxelWorldMod,
  useVoxelWorldMods,
  useVoxelWorldTags,
  useVoxelWorldVersion,
  useVoxelWorldVersions,
  voxelWorldTagForCategory,
  voxelWorldTagName,
  type VoxelWorldMod,
} from "../voxelWorld";

type Preview = {
  mainBuild?: MainBuild | null;
  profile: LocalProfile;
  plan: SignedInstallPlan;
  title: string;
  coverUrl?: string;
  newProfileName?: string;
};
type CatalogSource = "all" | "vspace" | "voxelworld";
type CatalogItem = {
  key: string;
  id: string;
  packageId?: string | null;
  source: "vspace" | "voxelworld";
  kind: Project["type"];
  slug: string;
  title: string;
  summary: string;
  downloads: number;
  updatedAt: string;
  footer: string;
  project?: Project;
  voxelWorld?: VoxelWorldMod;
};
type VoxelWorldInstallPreview = {
  packages: {
    title: string;
    version: string;
    selected: boolean;
  }[];
  incompatibilities: {
    title: string;
    version: string;
    supported_voxelcore: string[];
    chain: string[];
  }[];
};
export function Catalog({
  active = true,
  profiles,
  selected,
  select,
  busy,
  running,
  run,
  preview,
  deepLink,
  resetDetail,
  refreshProfiles,
  profileContext,
  openProfile,
  openExperimentalSettings,
}: {
  active?: boolean;
  profiles: LocalProfile[];
  selected: string;
  select: (id: string) => void;
  busy: boolean;
  running: Set<string>;
  run: RunTask;
  preview: (value: Preview) => void;
  deepLink: string;
  resetDetail: number;
  refreshProfiles: () => Promise<void>;
  profileContext?: { close: () => void };
  openProfile: (id: string) => void;
  openExperimentalSettings: () => void;
}) {
  const versionLabel = useVoxelCoreVersionLabel();
  const latestVoxelCore = useLatestPublishedVoxelCoreVersion();
  const inspect = useContentInspector();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("mod");
  const jointCatalogEnabled = useJointCatalogEnabled();
  const jointCatalog = jointCatalogEnabled && kind === "mod";
  const [source, setSource] = useState<CatalogSource>("all");
  const [offset, setOffset] = useState(0);
  const changePage = useCallback((nextOffset: number) => {
    setOffset(nextOffset);
    const scroller = document.querySelector<HTMLElement>("main");
    if (scroller) scroller.scrollTop = 0;
  }, []);
  const [sort, setSort] = useState("updated");
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [category, setCategory] = useState<string[]>([]);
  const [detail, setDetail] = useState("");
  const [search, setSearch] = useState(query);
  const activeRef = useRef(active);
  activeRef.current = active;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const listScrollTop = useRef(0);
  const restoreListScroll = useRef(false);
  const openDetail = useCallback((value: string) => {
    if (!detailRef.current) {
      listScrollTop.current = document.querySelector<HTMLElement>("main")?.scrollTop ?? 0;
    }
    restoreListScroll.current = false;
    setDetail(value);
  }, []);
  const closeDetail = useCallback(() => {
    if (detailRef.current) restoreListScroll.current = true;
    setDetail("");
  }, []);
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 200); return () => clearTimeout(timer); }, [query]);
  const catalogEngine = engineVersion(profiles.find(p => p.id === selected));
  const targetProfile = profileContext ? profiles.find(p => p.id === selected) : undefined;
  const quickAdd = (item: CatalogItem) => {
    if (!targetProfile || !catalogEngine || item.source !== "vspace" || !item.packageId) return;
    void run(`Проверка · ${item.title}`, async () => {
      const roots = [...new Set([...targetProfile.roots, item.packageId!])];
      const requirements = { ...targetProfile.root_requirements };
      delete requirements[item.packageId!];
      const plan = await resolveProject(
        roots,
        catalogEngine,
        requirements,
        ["stable"],
        {},
        undefined,
        profileRuntimeContext(targetProfile),
      );
      preview({ profile: targetProfile, plan, title: `Добавить ${item.title} · ${targetProfile.name}` });
    });
  };
  const params = new URLSearchParams({ limit: "24", offset: String(offset), sort, kind });
  if (latestVoxelCore) params.set("latest_voxelcore_version", latestVoxelCore);
  if (search.trim()) params.set("q", search.trim());
  for (const id of category) params.append("category", id);
  if (compatibleOnly && catalogEngine) params.set("voxelcore_version", catalogEngine);
  const result = useRegistryResource<{ items: Project[]; total: number }>(`/projects?${params}`, undefined, active && !jointCatalog);
  const categoryResult = useRegistryResource<CategoryOption[]>(`/categories?${new URLSearchParams({ kind })}`, undefined, active);
  const voxelWorldTags = useVoxelWorldTags(active && jointCatalog);
  const vspaceCategories = categoryResult.data ?? [];
  const tags = voxelWorldTags.data ?? [];
  const categories = useMemo(() => {
    if (!jointCatalog || source === "vspace") return vspaceCategories;
    if (source === "voxelworld") return mergeModCategories([], tags);
    return mergeModCategories(vspaceCategories, tags);
  }, [jointCatalog, source, vspaceCategories, tags]);
  const vspaceHasCategories = category.every((id) =>
    vspaceCategories.some((item) => item.id === id),
  );
  const voxelWorldSelectedTags = category.map((id) =>
    voxelWorldTagForCategory(id, tags),
  );
  const voxelWorldHasCategories = voxelWorldSelectedTags.every(Boolean);
  const includeVSpace =
    active &&
    jointCatalog &&
    source !== "voxelworld" &&
    vspaceHasCategories;
  const includeVoxelWorld =
    active &&
    jointCatalog &&
    source !== "vspace" &&
    !compatibleOnly &&
    voxelWorldHasCategories;
  const allVSpaceParams = new URLSearchParams({ sort, kind: "mod" });
  if (latestVoxelCore) allVSpaceParams.set("latest_voxelcore_version", latestVoxelCore);
  if (search.trim()) allVSpaceParams.set("q", search.trim());
  for (const id of category) allVSpaceParams.append("category", id);
  if (compatibleOnly && catalogEngine)
    allVSpaceParams.set("voxelcore_version", catalogEngine);
  const voxelWorldParams = new URLSearchParams({
    sort: sort === "updated" ? "4" : "1",
    sortOrder: sort === "title" ? "asc" : "desc",
  });
  if (search.trim()) voxelWorldParams.set("title", search.trim());
  for (const tag of voxelWorldSelectedTags)
    if (tag) voxelWorldParams.append("tag_id[]", String(tag.id));
  const allVSpace = useAllRegistryProjects(allVSpaceParams, includeVSpace);
  const allVoxelWorld = useVoxelWorldMods(voxelWorldParams, includeVoxelWorld);
  const categoryError = categoryResult.error || voxelWorldTags.error;
  const previous = useRef<typeof result.data>(undefined);
  if (result.data) previous.current = result.data;
  const regularPage = result.data ?? previous.current ?? { items: [], total: 0 };
  const jointItems = useMemo(() => {
    const items: CatalogItem[] = [];
    const vspaceProjects = includeVSpace ? allVSpace.data?.items ?? [] : [];
    const vspaceProjectKeys = new Set(
      vspaceProjects.flatMap((project) => [...catalogProjectKeys(project)]),
    );
    for (const project of vspaceProjects)
      items.push({
        key: `vspace:${project.id}`,
        id: project.slug,
        packageId: project.package_id,
        source: "vspace",
        kind: project.type,
        slug: project.slug,
        title: project.title,
        summary: project.summary,
        downloads: project.downloads,
        updatedAt: project.updated_at ?? "",
        footer: project.latest_release ? `v${project.latest_release.version}` : "Нет релизов",
        project,
      });
    for (const project of includeVoxelWorld ? allVoxelWorld.data?.items ?? [] : []) {
      if ([...catalogProjectKeys(project)].some((key) => vspaceProjectKeys.has(key)))
        continue;
      items.push({
        key: `voxelworld:${project.id}`,
        id: String(project.id),
        source: "voxelworld",
        kind: "mod",
        slug: project.slug,
        title: project.title,
        summary: project.description,
        downloads: project.downloads,
        updatedAt: project.last_update_date ?? "",
        footer: project.author.name,
        voxelWorld: project,
      });
    }
    items.sort((left, right) =>
      sort === "title"
        ? left.title.localeCompare(right.title, "ru", { sensitivity: "base" })
        : sort === "downloads"
          ? right.downloads - left.downloads ||
          (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
          : (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
    );
    return items;
  }, [allVSpace.data, allVoxelWorld.data, includeVSpace, includeVoxelWorld, sort]);
  const regularItems: CatalogItem[] = regularPage.items.map((project) => ({
    key: `vspace:${project.id}`,
    id: project.slug,
    packageId: project.package_id,
    source: "vspace",
    kind: project.type,
    slug: project.slug,
    title: project.title,
    summary: project.summary,
    downloads: project.downloads,
    updatedAt: project.updated_at ?? "",
    footer: project.latest_release ? `v${project.latest_release.version}` : "Нет релизов",
    project,
  }));
  const page = jointCatalog
    ? { items: jointItems.slice(offset, offset + 24), total: jointItems.length }
    : { items: regularItems, total: regularPage.total };
  const requestedSources = Number(includeVSpace) + Number(includeVoxelWorld);
  const loadedSources =
    Number(includeVSpace && !!allVSpace.data) +
    Number(includeVoxelWorld && !!allVoxelWorld.data);
  const loading = jointCatalog
    ? requestedSources > 0 && loadedSources === 0 && (allVSpace.loading || allVoxelWorld.loading)
    : result.loading && !previous.current;
  const updating = jointCatalog
    ? allVSpace.fetching || allVoxelWorld.fetching || search !== query
    : result.fetching || search !== query;
  const error = jointCatalog
    ? loadedSources === 0
      ? (includeVSpace ? allVSpace.error : "") ||
      (includeVoxelWorld ? allVoxelWorld.error : "")
      : ""
    : result.error;
  const partialError = jointCatalog && loadedSources > 0
    ? (includeVSpace ? allVSpace.error : "") ||
    (includeVoxelWorld ? allVoxelWorld.error : "")
    : "";
  const resetSeen = useRef(resetDetail);
  const refresh = () => {
    if (jointCatalog) {
      allVSpace.refresh();
      allVoxelWorld.refresh();
    } else result.refresh();
  };
  const setRetry = (_: unknown) => { refresh(); categoryResult.refresh(); voxelWorldTags.refresh(); };
  useEffect(() => {
    if (!active) return;
    if (deepLink) openDetail(deepLink);
    else if (detailRef.current) closeDetail();
  }, [active, closeDetail, deepLink, openDetail]);
  useEffect(() => {
    if (resetSeen.current === resetDetail) return;
    resetSeen.current = resetDetail;
    closeDetail();
  }, [closeDetail, resetDetail]);
  useLayoutEffect(() => {
    if (!active) return;
    const scroller = document.querySelector<HTMLElement>("main");
    if (!scroller) return;
    if (detail) {
      scroller.scrollTop = 0;
      return;
    }
    if (!restoreListScroll.current) return;
    restoreListScroll.current = false;
    const target = listScrollTop.current;
    scroller.scrollTop = target;
    // App also restores the active screen during navigation. Re-apply the
    // catalog position after both layout effects have completed.
    const frame = requestAnimationFrame(() => {
      if (activeRef.current && !detailRef.current) scroller.scrollTop = target;
    });
    return () => cancelAnimationFrame(frame);
  }, [active, detail]);
  if (detail) {
    if (detail.startsWith("voxelworld:") && !jointCatalogEnabled) {
      return <ProjectSurface title="Источник недоступен" close={closeDetail}>
        <p className="notice">Интеграция VoxelWorld выключена в настройках.</p>
      </ProjectSurface>;
    }
    return detail.startsWith("voxelworld:") ? (
      <VoxelWorldProjectView
        key={detail}
        slug={detail.slice("voxelworld:".length)}
        profiles={profiles}
        selected={selected}
        select={select}
        busy={busy}
        running={running}
        run={run}
        refreshProfiles={refreshProfiles}
        close={closeDetail}
      />
    ) : (
      <ProjectView
        key={detail}
        slug={detail}
        profiles={profiles}
        selected={selected}
        select={select}
        busy={busy}
        running={running}
        run={run}
        preview={preview}
        close={closeDetail}
        openProfile={openProfile}
        openExperimentalSettings={openExperimentalSettings}
      />
    );
  }
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Каталог</h1>
          {targetProfile && <p>Для профиля <strong>{targetProfile.name}</strong> · VoxelCore {catalogEngine ? versionLabel(catalogEngine) : "не выбран"}</p>}
          {profileContext && <button className="catalog-profile-back" onClick={profileContext.close}>← К профилю</button>}
        </div>
        <label className="search">
          <Icon name="search" size={18} />
          <input
            aria-label="Поиск в каталоге"
            placeholder="Поиск по названию…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
          {query && (
            <button
              className="icon-button"
              aria-label="Очистить поиск"
              onClick={() => {
                setQuery("");
                setOffset(0);
              }}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </label>
      </header>
      <div className="catalog-toolbar">
        <div className="filter-row" aria-label="Тип контента">
          {[
            ["mod", "Контент-паки"],
            ["modpack", "Сборки"],
            ["project", "Проекты"],
            ["world", "Карты"],
          ].map(([id, name]) => (
            <button
              key={id}
              aria-pressed={kind === id}
              className={kind === id ? "active" : ""}
              onClick={() => {
                setKind(id);
                setCategory([]);
                setOffset(0);
              }}
            >
              {name}
            </button>
          ))}
        </div>
        <label>
          <span className="sr-only">Сортировка</span>
          <Select
            aria-label="Сортировка каталога"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value);
              setOffset(0);
            }}
          >
            <option value="updated">Недавно обновлены</option>
            <option value="downloads">Популярные</option>
            <option value="title">По названию</option>
          </Select>
        </label>
      </div>
      {jointCatalog && (
        <div className="catalog-source-row">
          <span className="supporting-label">Источник</span>
          <div className="filter-row" aria-label="Источник каталога">
            {[
              ["all", "Все"],
              ["vspace", "VSpace"],
              ["voxelworld", "VoxelWorld"],
            ].map(([id, name]) => (
              <button
                key={id}
                aria-pressed={source === id}
                className={source === id ? "active" : ""}
                onClick={() => {
                  setSource(id as CatalogSource);
                  setCategory([]);
                  setCompatibleOnly(false);
                  setOffset(0);
                }}
              >
                {name}
              </button>
            ))}
          </div>
          <span className="experimental-badge">Экспериментально</span>
        </div>
      )}
      <div className="catalog-categories" aria-label="Категории">
        {profiles.find(p => p.id === selected)?.main_build && <p>В профиле выбрана сборка main. Фильтр смотрит только на версию движка, поэтому некоторые пакеты могут не работать.</p>}
        <label className="checkbox-row">
          <input type="checkbox" disabled={!catalogEngine} checked={compatibleOnly && !!catalogEngine} onChange={(event) => {
            setCompatibleOnly(event.target.checked);
            setOffset(0);
          }} />
          {catalogEngine ? `Только совместимые с VoxelCore ${versionLabel(catalogEngine)}` : "Для проверки совместимости выберите профиль с версией VoxelCore"}
        </label>
        <span className="catalog-filter-label supporting-label">Категории</span>
        <CategoryFilter items={categories} value={category} onChange={next => { setCategory(next); setOffset(0); }} />
        {categoryError && (
          <span className="category-error">
            Не удалось загрузить категории.
            <button onClick={() => setRetry(null)}>Повторить</button>
          </span>
        )}
        {jointCatalog && compatibleOnly && source !== "vspace" && (
          <p className="muted">У VoxelWorld нет данных о совместимости с выбранной версией, поэтому показаны только проекты VSpace.</p>
        )}
      </div>
      {partialError && <ErrorNotice retry={refresh}>Один из источников недоступен. Показаны результаты второго.</ErrorNotice>}
      {error && !jointCatalog && previous.current && <ErrorNotice retry={refresh}>Не удалось обновить каталог. Показаны ранее загруженные данные.</ErrorNotice>}
      <p className="catalog-refresh-status" role="status">{updating && !loading ? "Обновляем результаты…" : ""}</p>
      {error && (jointCatalog || !previous.current) ? (
        <ErrorNotice retry={() => setRetry(null)}>
          <strong>Каталог недоступен</strong>
          <p>Установленные игры остаются в библиотеке.</p>
          <details>
            <summary>Технические подробности</summary>
            {error}
          </details>
        </ErrorNotice>
      ) : loading ? (
        <CatalogSkeleton />
      ) : !page.items.length ? (
        <Empty
          icon="search"
          title={
            compatibleOnly ? "Совместимые проекты не найдены" : query || category.length ? "Ничего не найдено" : "В этом разделе пока нет публикаций"
          }
        >
          <p>
            {compatibleOnly
              ? `Для VoxelCore ${versionLabel(catalogEngine)} ничего не найдено. Можно выключить фильтр совместимости.`
              : query || category.length
                ? "Попробуйте другое название или выберите все категории."
                : "Здесь появятся опубликованные и проверенные проекты."}
          </p>
          {(compatibleOnly || query || category.length > 0) && (
            <button
              onClick={() => {
                setQuery("");
                setCategory([]);
                setCompatibleOnly(false);
                setOffset(0);
              }}
            >
              Сбросить фильтры
            </button>
          )}
        </Empty>
      ) : (
        <>
          <div className="catalog-grid" aria-busy={updating}>
            {page.items.map((project) => (
              <div className={profileContext ? "catalog-profile-card" : "catalog-card-container"} key={project.key}>
              <button
                className="catalog-card"
                disabled={updating}
                onClick={() => profileContext
                  ? inspect({ source: project.source, slug: project.source === "vspace" ? project.id : project.slug, title: project.title, parent: targetProfile?.name, engine: catalogEngine })
                  : openDetail(project.source === "voxelworld" ? `voxelworld:${project.slug}` : project.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void popupMenu([
                    { text: "Быстрый просмотр", action: () => inspect({ source: project.source, slug: project.source === "vspace" ? project.id : project.slug, title: project.title }) },
                    { text: "Открыть страницу", action: () => openDetail(project.source === "voxelworld" ? `voxelworld:${project.slug}` : project.id) },
                    ...(project.source === "voxelworld"
                      ? [{ text: "Открыть на VoxelWorld", action: () => void openUrl(`https://voxelworld.ru/mods/${encodeURIComponent(project.slug)}`) }]
                      : []),
                  ], contextMenuPosition(event));
                }}
              >
                <div className="catalog-card-top">
                  {project.project ? <ProjectIcon project={project.project} /> : <ExternalProjectIcon project={project.voxelWorld!} />}
                  <div>
                    <span className="eyebrow supporting-label">
                      {kinds[project.kind]}{jointCatalog ? ` · ${project.source === "vspace" ? "VSpace" : "VoxelWorld"}` : ""}
                    </span>
                    <h2>{project.title}</h2>
                  </div>
                </div>
                {(() => {
                  const requirement = project.project?.latest_release?.effective_voxelcore_main ??
                    project.project?.latest_release?.attestation?.assertion?.manifest?.voxelcore_main;
                  return requirement && (!latestVoxelCore || compareSemVer(latestVoxelCore, requirement.target_version) < 0)
                    ? <span className="catalog-main-warning" title={`Минимальный коммит ${requirement.min_commit}`}>
                        <Icon name="warning" size={15} /> Требует экспериментальный VoxelCore {formatVoxelCoreVersion(requirement.target_version)}
                      </span>
                    : null;
                })()}
                <p>{project.summary || "Автор пока не добавил описание."}</p>
                <footer>
                  <span>{project.footer}</span>
                  <span>
                    <Icon name="download" size={14} />
                    {project.downloads.toLocaleString("ru")}
                  </span>
                </footer>
              </button>
              {targetProfile && <div className="catalog-profile-card-actions">
                <span>{(project.source === "vspace"
                  ? targetProfile.packages.find(pkg => pkg.id === project.packageId)?.version
                  : targetProfile.external_packages?.find(pkg => pkg.slug === project.slug)?.version)
                  ? `Установлен · ${project.source === "vspace" ? targetProfile.packages.find(pkg => pkg.id === project.packageId)?.version : targetProfile.external_packages?.find(pkg => pkg.slug === project.slug)?.version}`
                  : project.packageId && targetProfile.manual_packages?.includes(project.packageId) ? "Добавлен вручную" : "Не установлен"}</span>
                {project.source === "vspace" && project.kind === "mod" ? <button
                  disabled={busy || updating || !catalogEngine || running.has(targetProfile.id) || !project.packageId || targetProfile.packages.some(pkg => pkg.id === project.packageId) || targetProfile.manual_packages?.includes(project.packageId ?? "") || !project.project?.latest_release}
                  onClick={() => quickAdd(project)}><Icon name="plus" size={14} />Добавить</button>
                  : <button onClick={() => openDetail(project.source === "voxelworld" ? `voxelworld:${project.slug}` : project.id)}>Версии и установка</button>}
              </div>}
              </div>
            ))}
          </div>
          <div className="pagination">
            <span>
              {offset + 1}–{offset + page.items.length} из {page.total}
            </span>
            <div className="actions">
              <button
                disabled={offset === 0}
                onClick={() => changePage(Math.max(0, offset - 24))}
              >
                Назад
              </button>
              <button
                disabled={offset + 24 >= page.total}
                onClick={() => changePage(offset + 24)}
              >
                Далее
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
function ExternalProjectIcon({ project }: { project: VoxelWorldMod }) {
  const [failed, setFailed] = useState(false);
  return project.logo_url && !failed ? (
    <img
      className="project-icon"
      src={project.logo_url}
      alt=""
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="project-icon"><Icon name="package" size={26} /></span>
  );
}
function ProjectIcon({ project }: { project: Project & { description?: string } }) {
  const image = project.cover_url || project.latest_release?.preview_url || markdownImage(project.description);
  return image ? (
    <PrivateImage
      className="project-icon"
      src={image}
      alt=""
      fallback={<span className="project-icon"><Icon name="package" size={26} /></span>}
    />
  ) : (
    <span className={`project-icon ${project.type}`}>
      <Icon
        name={project.type === "world" ? "world" : project.type === "modpack" ? "catalog" : project.type === "project" ? "terminal" : "package"}
        size={26}
      />
    </span>
  );
}

function ModpackContents({
  release,
  projectTitle,
}: {
  release: Release;
  projectTitle: string;
}) {
  const inspect = useContentInspector();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const vspace = (release.dependencies ?? [])
    .filter((item) => item.kind !== "conflict")
    .map((item) => ({
      key: `vspace:${item.id}`,
      source: "VSpace",
      title: item.id,
      version: item.requirement,
      open: () => inspect({
        source: "vspace",
        slug: item.id,
        requirement: item.requirement,
        relation: item.kind,
        parent: projectTitle,
        engine: exactVoxelCoreVersion(release.voxelcore),
      }),
    }));
  const external = (release.attestation?.assertion?.manifest?.external_packages ?? [])
    .map((item) => ({
      key: `${item.source}:${item.id}`,
      source: item.source === "voxelworld" ? "VoxelWorld" : item.source,
      title: item.title || item.id,
      version: item.version,
      open: () => inspect({
        source: "voxelworld",
        slug: item.slug,
        title: item.title,
        version: item.version,
        versionId: item.version_id,
        relation: "required",
        parent: projectTitle,
      }),
    }));
  const packages = [...vspace, ...external];
  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const matches = normalizedQuery
    ? packages.filter((item) =>
        [item.title, item.key, item.source, item.version]
          .some((value) => value.toLocaleLowerCase("ru").includes(normalizedQuery)),
      )
    : packages;
  const visible = normalizedQuery || expanded ? matches : matches.slice(0, 12);

  return (
    <section className="modpack-contents">
      <header>
        <div>
          <h2>Состав сборки</h2>
          <p>Контент, который будет установлен в отдельный профиль.</p>
        </div>
        <span>{packages.length} пакетов</span>
      </header>
      {packages.length ? (
        <>
          {packages.length > 12 && (
            <input
              type="search"
              aria-label="Поиск по составу сборки"
              placeholder="Найти пакет в сборке…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
          <div className={`modpack-content-grid${expanded || normalizedQuery ? " scrollable" : ""}`}>
            {visible.map((item) => (
              <button key={item.key} onClick={item.open}>
                <Icon name="package" size={20} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.source}</small>
                </span>
                <code>{item.version}</code>
              </button>
            ))}
          </div>
          {!matches.length && <p className="modpack-content-empty">В составе ничего не найдено.</p>}
          {!normalizedQuery && packages.length > 12 && (
            <button className="modpack-content-toggle" onClick={() => setExpanded((value) => !value)}>
              {expanded ? "Свернуть состав" : `Показать все пакеты · ${packages.length}`}
            </button>
          )}
        </>
      ) : (
        <p className="modpack-content-empty">Для этой версии состав не указан.</p>
      )}
    </section>
  );
}
function ProjectSurface({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return (
    <section className="catalog-project-page">
      <header className="project-page-heading">
        <button className="project-back" onClick={close}>← К каталогу</button>
        <div>
          <span className="supporting-label">Каталог / проект</span>
          <h1>{title}</h1>
        </div>
      </header>
      {children}
    </section>
  );
}
function VoxelWorldProjectView({
  slug,
  profiles,
  selected,
  select,
  busy,
  running,
  run,
  refreshProfiles,
  close,
}: {
  slug: string;
  profiles: LocalProfile[];
  selected: string;
  select: (id: string) => void;
  busy: boolean;
  running: Set<string>;
  run: RunTask;
  refreshProfiles: () => Promise<void>;
  close: () => void;
}) {
  const versionLabel = useVoxelCoreVersionLabel();
  const inspect = useContentInspector();
  const result = useVoxelWorldMod(slug);
  const project = result.data;
  const versionsResult = useVoxelWorldVersions(slug);
  const versions = versionsResult.data ?? [];
  const installableProfiles = profiles.filter((item) => !isProjectProfile(item));
  const profile = installableProfiles.find((item) => item.id === selected) ?? installableProfiles[0];
  const profileEngine = engineVersion(profile);
  const [versionId, setVersionId] = useState(0);
  const [compatibilityWarning, setCompatibilityWarning] =
    useState<VoxelWorldInstallPreview>();
  const [checkingCompatibility, setCheckingCompatibility] = useState(false);
  const [compatibilityError, setCompatibilityError] = useState("");
  const selectedVersion = versions.find((version) => version.id === versionId);
  const versionResult = useVoxelWorldVersion(slug, versionId);
  const versionDetail = versionResult.data;
  const compatible =
    !!selectedVersion &&
    (!selectedVersion.engine.length ||
      selectedVersion.engine.some((item) =>
        sameEngineVersion(item.version_number, profileEngine),
      ));
  useEffect(() => {
    if (!versions.length) return;
    setVersionId((current) => {
      if (versions.some((version) => version.id === current)) return current;
      return (
        versions.find(
          (version) =>
            !version.engine.length ||
            version.engine.some((item) =>
              sameEngineVersion(item.version_number, profileEngine),
            ),
        ) ?? versions[0]
      ).id;
    });
  }, [versions, profileEngine]);
  const openProject = () =>
    void openUrl(`https://voxelworld.ru/mods/${encodeURIComponent(slug)}`);
  const applyInstall = (allowIncompatible: boolean) => {
    if (!project || !profile || !selectedVersion || !versionDetail) return;
    void run(`Установка ${project.title}`, async (stage) => {
      stage("Загружаем и проверяем архивы VoxelWorld…");
      await invoke("install_voxelworld_mod", {
        profileId: profile.id,
        projectId: project.id,
        slug: project.slug,
        versionId: selectedVersion.id,
        allowIncompatible,
      });
      await refreshProfiles();
    }).then((ok) => {
      if (ok) close();
    });
  };
  const install = async () => {
    if (!project || !profile || !selectedVersion || !versionDetail) return;
    setCheckingCompatibility(true);
    setCompatibilityError("");
    try {
      const preview = await invoke<VoxelWorldInstallPreview>(
        "preview_voxelworld_install",
        {
          profileId: profile.id,
          projectId: project.id,
          slug: project.slug,
          versionId: selectedVersion.id,
        },
      );
      setCompatibilityWarning(preview);
    } catch (error) {
      setCompatibilityError(friendlyError(error));
    } finally {
      setCheckingCompatibility(false);
    }
  };
  return (
    <>
    <ProjectSurface title={project?.title ?? "Проект VoxelWorld"} close={close}>
      {result.error && !project ? (
        <ErrorNotice retry={result.refresh}>{result.error}</ErrorNotice>
      ) : !project ? (
        <div className="loading">Загружаем описание…</div>
      ) : (
        <>
          {result.error && <ErrorNotice retry={result.refresh}>Не удалось обновить данные. Показана сохранённая карточка.</ErrorNotice>}
          <div className="project-page-layout">
            <div className="project-page-content">
          <div className="project-detail-title">
            <ExternalProjectIcon project={project} />
            <div>
              <span>Контент-пак · VoxelWorld · {project.author.name}</span>
              <p>{project.description}</p>
            </div>
          </div>
          <section className="project-overview">
            <h2>О проекте</h2>
            <div className="project-description selectable">
              <Markdown text={project.detail_description || project.description || "Автор пока не добавил подробное описание."} />
            </div>
            {!!project.tags.length && (
              <div className="external-project-tags" aria-label="Категории проекта">
                {project.tags.map((tag) => (
                  <span key={tag.id}>{voxelWorldTagName(tag.title)}</span>
                ))}
              </div>
            )}
          </section>
          <dl className="metadata">
            <div>
              <dt>Загрузки</dt>
              <dd>{project.downloads.toLocaleString("ru")}</dd>
            </div>
            <div>
              <dt>Обновлён</dt>
              <dd>
                {project.last_update_date
                  ? new Date(project.last_update_date).toLocaleDateString("ru")
                  : "Не указано"}
              </dd>
            </div>
          </dl>
            </div>
            <aside className="project-install-panel">
              <h2>Установка</h2>
          {versionsResult.error && !versions.length ? (
            <ErrorNotice retry={versionsResult.refresh}>Не удалось загрузить версии проекта.</ErrorNotice>
          ) : versionsResult.loading ? (
            <p role="status">Загружаем версии…</p>
          ) : versions.length ? (
            <>
              <div className="form-columns">
                <label>
                  Версия проекта
                  <Select
                    value={versionId}
                    disabled={checkingCompatibility}
                    onChange={(event) => {
                      setVersionId(Number(event.target.value));
                      setCompatibilityWarning(undefined);
                      setCompatibilityError("");
                    }}
                  >
                    {versions.map((version) => (
                      <option key={version.id} value={version.id}>
                        {version.version_number} · {voxelWorldChannel(version.status.title)}
                      </option>
                    ))}
                  </Select>
                </label>
                <label>
                  Установить в профиль
                  <Select
                    value={profile?.id ?? ""}
                    onChange={(event) => {
                      select(event.target.value);
                      setCompatibilityWarning(undefined);
                      setCompatibilityError("");
                    }}
                    disabled={!installableProfiles.length || checkingCompatibility}
                  >
                    <option value="" disabled>Выберите профиль</option>
                    {installableProfiles.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {engineVersion(item) ? versionLabel(engineVersion(item)) : "версия не выбрана"}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              {selectedVersion && (
                <div className="release-info">
                  <span>
                    VoxelCore {voxelWorldEngineRange(selectedVersion.engine.map((item) => item.version_number))}
                  </span>
                  <span>{selectedVersion.created_at?.slice(0, 10) || "Дата не указана"}</span>
                </div>
              )}
              {selectedVersion?.changelog && (
                <details>
                  <summary>Изменения в версии {selectedVersion.version_number}</summary>
                  <p className="preserve-lines">{selectedVersion.changelog}</p>
                </details>
              )}
              {!!versionDetail?.dependencies?.length && (
                <section className="release-dependencies">
                  <h3>Зависимости</h3>
                  {versionDetail.dependencies.map((dependency) => (
                    <div className="dependency-card" key={`${dependency.project.id}-${dependency.id}`}>
                      <div className="dependency-card-heading">
                        <button className="dependency-project-link" onClick={() => inspect({ source: "voxelworld", slug: dependency.project.slug, title: dependency.project.title, version: dependency.version_number, versionId: dependency.id, parent: project.title, relation: "required" })}>
                          {dependency.project.title}
                        </button>
                        <span>Обязательная</span>
                      </div>
                      <footer>
                        <span>VoxelWorld</span>
                        <code>{dependency.version_number}</code>
                      </footer>
                    </div>
                  ))}
                </section>
              )}
              {versionResult.loading && <p role="status">Проверяем зависимости…</p>}
              {versionResult.error && (
                <ErrorNotice retry={versionResult.refresh}>Не удалось проверить зависимости выбранной версии.</ErrorNotice>
              )}
              {compatibilityError && (
                <ErrorNotice retry={() => void install()}>{compatibilityError}</ErrorNotice>
              )}
              {profile && !profileEngine && <ErrorNotice>В профиле не выбрана версия VoxelCore.</ErrorNotice>}
              {profileEngine && selectedVersion && !compatible && (
                <ErrorNotice>
                  Эта версия не поддерживает VoxelCore {versionLabel(profileEngine)}. Перед установкой VLauncher покажет подробности.
                </ErrorNotice>
              )}
              {profile && running.has(profile.id) && <div className="notice">Завершите игру, чтобы изменить её контент.</div>}
              <div className="notice external-source-warning">
                Архивы загружаются с VoxelWorld и не имеют опубликованной подписи или контрольной суммы.
              </div>
            </>
          ) : (
            <p className="notice">У проекта пока нет доступных версий.</p>
          )}
          <div className="modal-actions">
            <button onClick={openProject}>Открыть на VoxelWorld</button>
            {!!versions.length && (
              <button
                className="primary"
                disabled={
                  busy ||
                  checkingCompatibility ||
                  !profile ||
                  !profileEngine ||
                  !selectedVersion ||
                  !versionDetail ||
                  running.has(profile.id)
                }
                onClick={() => void install()}
              >
                {checkingCompatibility
                  ? "Проверяем…"
                  : profile?.external_packages?.some((item) => item.project_id === project.id)
                    ? "Обновить"
                    : "Установить"}
              </button>
            )}
          </div>
            </aside>
          </div>
        </>
      )}
    </ProjectSurface>
    {compatibilityWarning && profile && project && (
      <Modal
        title={`Установка ${project.title}`}
        close={() => setCompatibilityWarning(undefined)}
        busy={busy}
      >
        <p>
          Профиль <strong>{profile.name}</strong> · VoxelCore {versionLabel(profileEngine)}
        </p>
        <div className="install-changes">
          {compatibilityWarning.packages.map((item, index) => (
            <div key={`${item.title}:${item.version}:${index}`}>
              <div>
                <strong>{item.title}</strong>
                <small>{item.selected ? "Выбранный пакет" : "Зависимость"} · {item.version}</small>
              </div>
              <span className="muted">Добавить</span>
            </div>
          ))}
        </div>
        {!!compatibilityWarning.incompatibilities.length && (
          <>
            <div className="compatibility-issues">
              {compatibilityWarning.incompatibilities.map((issue) => (
                <div key={`${issue.chain.join(":")}:${issue.version}`}>
                  <strong>{issue.title} · {issue.version}</strong>
                  <small>{issue.chain.join(" → ")}</small>
                  <span>Поддерживает VoxelCore: {issue.supported_voxelcore.join(", ")}</span>
                </div>
              ))}
            </div>
            <div className="notice">
              Некоторые версии не заявляют поддержку выбранного VoxelCore. Они могут не запуститься или повредить данные мира.
            </div>
          </>
        )}
        {busy && <div className="notice">Загружаем и проверяем архивы VoxelWorld… Профиль изменится только после успешной проверки всего набора.</div>}
        <div className="modal-actions">
          <button disabled={busy} onClick={() => setCompatibilityWarning(undefined)}>Отмена</button>
          <button className="primary" disabled={busy} onClick={() => applyInstall(compatibilityWarning.incompatibilities.length > 0)}>
            {busy ? "Устанавливаем…" : compatibilityWarning.incompatibilities.length ? "Установить всё равно" : "Установить"}
          </button>
        </div>
      </Modal>
    )}
    </>
  );
}
function sameEngineVersion(left: string, right: string) {
  const supported = numericVersion(left);
  const current = numericVersion(right);
  if (!supported || !current) {
    return normalizeVersion(left) === normalizeVersion(right);
  }
  if (supported.length === 2) {
    return supported[0] === current[0] && supported[1] === current[1];
  }
  return supported.every((part, index) => part === (current[index] ?? 0));
}
function normalizeVersion(value: string) {
  return value.trim().replace(/^v/i, "");
}
function numericVersion(value: string) {
  const core = normalizeVersion(value).split(/[+-]/, 1)[0];
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(core)) return null;
  return core.split(".").map(Number);
}
function voxelWorldEngineRange(versions: string[]) {
  if (!versions.length) return "любая версия";
  const parsed = versions.map(numericVersion);
  if (parsed.every((version): version is number[] => !!version && version.length === 2)) {
    const unique = [...new Map(parsed.map((version) => [`${version[0]}.${version[1]}`, version])).values()]
      .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const first = unique[0];
    const last = unique[unique.length - 1];
    const contiguous = unique.every(
      (version, index) => version[0] === first[0] && version[1] === first[1] + index,
    );
    if (contiguous) {
      return `≥${first[0]}.${first[1]}.0 и <${last[0]}.${last[1] + 1}.0`;
    }
  }
  return versions.join(", ");
}
function voxelWorldChannel(channel: string) {
  return channel === "release"
    ? "Стабильная"
    : channel === "beta"
      ? "Бета"
      : channel === "alpha"
        ? "Альфа"
        : channel;
}
type DependencyKind = NonNullable<Release["dependencies"]>[number]["kind"];
function dependencyKindLabel(kind: DependencyKind) {
  return kind === "required"
    ? "Обязательная"
    : kind === "optional"
      ? "Необязательная"
      : kind === "conflict"
        ? "Конфликт"
        : "Порядок загрузки";
}
export function ProjectView({
  slug,
  profiles,
  selected,
  select,
  busy,
  running,
  run,
  preview,
  close,
  openProfile,
  openExperimentalSettings,
}: {
  slug: string;
  profiles: LocalProfile[];
  selected: string;
  select: (id: string) => void;
  busy: boolean;
  running: Set<string>;
  run: RunTask;
  preview: (value: Preview) => void;
  close: () => void;
  openProfile: (id: string) => void;
  openExperimentalSettings: () => void;
}) {
  const versionLabel = useVoxelCoreVersionLabel();
  const latestVoxelCore = useLatestPublishedVoxelCoreVersion();
  const publishedVoxelCoreVersions = usePublishedVoxelCoreVersions();
  const { status: mainlineStatus } = useMainlineStatus();
  const inspect = useContentInspector();
  const compatibilityQuery = latestVoxelCore
    ? `?${new URLSearchParams({ latest_voxelcore_version: latestVoxelCore })}`
    : "";
  const projectResult = useRegistryResource<ProjectDetail>(`/projects/${encodeURIComponent(slug)}${compatibilityQuery}`);
  const releasesResult = useRegistryResource<Release[]>(`/projects/${encodeURIComponent(slug)}/releases${compatibilityQuery}`);
  const project = projectResult.data;
  useEffect(() => { if (project) recordContent(project.slug, "view"); }, [project?.slug]);
  const releases = releasesResult.data ?? [];
  const [version, setVersion] = useState("");
  const retryDetails = () => { projectResult.refresh(); releasesResult.refresh(); };
  const [failed, setFailed] = useState(false);
  const [reportToken, setReportToken] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [reportStatus, setReportStatus] = useState("");
  const [linkCopied, setLinkCopied] = useState(false);
  useEffect(() => {
    void invoke<string | null>("load_access_token")
      .then((value) => setReportToken(value ?? ""))
      .catch(() => { });
  }, []);
  useEffect(() => {
    if (releasesResult.data) setVersion(current => releasesResult.data!.some(r => r.version === current) ? current : (releasesResult.data!.find(r => r.channel === 'stable' && !r.deprecated)?.version ?? releasesResult.data![0]?.version ?? ""));
  }, [releasesResult.data]);
  const release = releases.find((r) => r.version === version);
  const mainRequirement = release?.effective_voxelcore_main ??
    release?.attestation?.assertion?.manifest?.voxelcore_main;
  const targetIsStable = !!mainRequirement && !!latestVoxelCore &&
    compareSemVer(latestVoxelCore, mainRequirement.target_version) >= 0;
  const releaseComponents = release?.attestation?.assertion?.manifest?.components ?? [];
  const installableProfiles = profiles.filter((item) => !isProjectProfile(item));
  const profile = installableProfiles.find((item) => item.id === selected) ?? installableProfiles[0];
  const standalone = project?.type === "modpack" || project?.type === "project";
  const installedModpackProfile = standalone
    ? profiles.find((item) => item.packages.some((pkg) => pkg.id === project?.id && (pkg.kind === "modpack" || pkg.kind === "project")))
    : undefined;
  const installedModpack = installedModpackProfile?.packages.find((pkg) => pkg.id === project?.id);
  const selectedModpackIsInstalled = installedModpack?.version === version;
  const installIdentity = project?.type === "mod" ? project.package_id : project?.id;
  const installed = profile?.packages.find((p) => p.id === installIdentity);
  const manualCollision = project?.type === "mod" && !!project.package_id &&
    (profile?.manual_packages?.includes(project.package_id) ?? false);
  const createsProjectProfile = !standalone && !installableProfiles.length;
  const install = () => {
    if (!release || !project) return;
    void run(`Проверка · ${project.title}`, async () => {
      const modpackEngine = standalone
        ? exactVoxelCoreVersion(release.voxelcore)
        : "";
      if (standalone && !modpackEngine) {
        throw new Error("Проект не закрепляет точную версию VoxelCore. Автору нужно выпустить исправленную версию.");
      }
      const createProjectProfile = !standalone && !profile && !installableProfiles.length;
      if (!standalone && !profile && !createProjectProfile) return;
      const pendingProfile: LocalProfile | undefined = createProjectProfile
        ? {
            id: "pending-project",
            name: "Новый профиль",
            icon: null,
            active_revision: null,
            voxelcore_version: null,
            roots: [],
            root_requirements: {},
            packages: [],
            external_packages: [],
            manual_packages: [],
          }
        : undefined;
      const targetProfile = standalone
        ? installedModpackProfile
        : profile ?? pendingProfile;
      const directProject = standalone || project.type === "world";
      if (!directProject && !project.package_id) {
        throw new Error("Контент-пак ещё не получил идентификатор из package.json.");
      }
      const roots = directProject
        ? (targetProfile?.roots ?? []).filter((root) => root !== project.id)
        : [...new Set([...(targetProfile?.roots ?? []), project.package_id!])];
      const requirements = { ...(targetProfile?.root_requirements ?? {}) };
      delete requirements[project.id];
      if (!directProject) requirements[project.package_id!] = `=${version}`;
      const channels = release.channel === "stable" ? ["stable"] : ["stable", release.channel];
      let voxelcoreVersion = standalone ? modpackEngine : engineVersion(targetProfile);
      let selectedMainBuild: MainBuild | null = null;
      let runtime = standalone
        ? { kind: "stable" as const, version: modpackEngine }
        : profileRuntimeContext(targetProfile);
      const recommendedMainBuild = async (requirement: VoxelCoreMainRequirement) => {
        if (!mainlineStatus.enabled) {
          throw new Error("Для DEV-версии включите экспериментальные сборки в настройках, затем повторите установку.");
        }
        const catalog = await invoke<{ builds: MainBuild[] }>("list_mainline_builds");
        const build = catalog.builds.find(
          (item) => formatVoxelCoreVersion(item.engine_version ?? "") === formatVoxelCoreVersion(requirement.target_version),
        );
        if (!build) throw new Error(`Для VoxelCore ${formatVoxelCoreVersion(requirement.target_version)} сейчас нет доступной DEV-сборки для этой системы.`);
        return invoke<MainBuild>("resolve_mainline_version", { build });
      };
      if (
        mainRequirement &&
        !targetIsStable &&
        !standalone &&
        formatVoxelCoreVersion(targetProfile?.main_build?.engine_version ?? "") !== formatVoxelCoreVersion(mainRequirement.target_version)
      ) {
        selectedMainBuild = await recommendedMainBuild(mainRequirement);
        runtime = mainRuntimeContext(selectedMainBuild);
        voxelcoreVersion = selectedMainBuild.engine_version ?? mainRequirement.target_version;
      }
      const makePlan = () => resolveProject(
        roots,
        voxelcoreVersion,
        requirements,
        channels,
        {},
        directProject ? { id: project.id, version } : undefined,
        runtime,
      );
      let plan: SignedInstallPlan | undefined;
      if (createProjectProfile && !selectedMainBuild) {
        const requirementMinimum = parseVersionRequirement(release.voxelcore).minimum;
        const candidates = [...new Set([
          exactVoxelCoreVersion(release.voxelcore),
          ...publishedVoxelCoreVersions,
          requirementMinimum ?? "",
          latestVoxelCore,
        ].filter(Boolean))].sort((left, right) => compareSemVer(right, left));
        let lastError: unknown = new Error("Для этого проекта не найдена совместимая версия VoxelCore.");
        for (const candidate of candidates) {
          voxelcoreVersion = candidate;
          runtime = { kind: "stable", version: candidate };
          try {
            plan = await makePlan();
            break;
          } catch (reason) {
            lastError = reason;
          }
        }
        if (!plan) {
          const dependencyRequirement = mainRequirementFromResolutionError(lastError);
          if (!dependencyRequirement) throw lastError;
          selectedMainBuild = await recommendedMainBuild(dependencyRequirement);
          runtime = mainRuntimeContext(selectedMainBuild);
          voxelcoreVersion = selectedMainBuild.engine_version ?? dependencyRequirement.target_version;
          plan = await makePlan();
        }
      } else {
        try {
          plan = await makePlan();
        } catch (reason) {
          const dependencyRequirement = mainRequirementFromResolutionError(reason);
          if (!dependencyRequirement || standalone) throw reason;
          selectedMainBuild = await recommendedMainBuild(dependencyRequirement);
          runtime = mainRuntimeContext(selectedMainBuild);
          voxelcoreVersion = selectedMainBuild.engine_version ?? dependencyRequirement.target_version;
          plan = await makePlan();
        }
      }
      const automaticProfileName = createProjectProfile
        ? `VoxelCore ${formatVoxelCoreVersion(voxelcoreVersion)}${selectedMainBuild ? " DEV" : ""}`
        : undefined;
      preview({
        mainBuild: selectedMainBuild,
        profile: standalone && !targetProfile
          ? {
              id: "pending-modpack",
              name: project.title,
              icon: null,
              active_revision: null,
              voxelcore_version: modpackEngine,
              roots: [],
              root_requirements: {},
              packages: [],
              external_packages: [],
              manual_packages: [],
            }
          : targetProfile!,
        plan,
        title: createProjectProfile
          ? `Новый профиль · ${automaticProfileName}`
          : standalone
            ? targetProfile
              ? `${project.title} · ${installedModpack?.version} → ${version}`
              : `Новый профиль · ${project.title}`
            : `Установка ${project.title}`,
        coverUrl: standalone && !targetProfile
          ? project.cover_url ?? release.preview_url ?? undefined
          : undefined,
        newProfileName: standalone && !targetProfile
          ? project.title
          : automaticProfileName,
      });
      close();
    }).then((ok) => setFailed(!ok));
  };
  return (
    <ProjectSurface title={project?.title ?? "Проект"} close={close}>
      {projectResult.error && !project ? (
        <ErrorNotice retry={retryDetails}>{projectResult.error}</ErrorNotice>
      ) : !project ? (
        <div className="loading">Загружаем описание…</div>
      ) : (
        <>
          {(projectResult.error || releasesResult.error) && <ErrorNotice retry={retryDetails}>Не удалось обновить данные проекта. Повторите перед установкой.</ErrorNotice>}
          {releasesResult.loading && <p role="status">Загружаем версии…</p>}
          <div className="project-page-layout">
            <div className="project-page-content">
          <div className="project-detail-title">
            <ProjectIcon project={project} />
            <div>
              <span>
                {kinds[project.type]} ·{" "}
                {typeof project.owner === "string" ? project.owner : ""}
              </span>
              <p>{project.summary}</p>
            </div>
          </div>
          <section className="project-overview">
            <h2>{project.type === "modpack" ? "О сборке" : "О проекте"}</h2>
            <div className="project-description selectable">
              <Markdown text={project.description || "Автор пока не добавил подробное описание."} />
            </div>
            {!!project.gallery_urls?.length && (
              <div className="project-gallery">
                {project.gallery_urls.map((url) => (
                  <PrivateImage key={url} src={url} alt={`Скриншот ${project.title}`} />
                ))}
              </div>
            )}
          </section>
          {project.type === "modpack" && release && (
            <ModpackContents release={release} projectTitle={project.title} />
          )}
          <dl className="metadata">
            <div>
              <dt>Загрузки</dt>
              <dd>{project.downloads.toLocaleString("ru")}</dd>
            </div>
            <div>
              <dt>Обновлён</dt>
              <dd>{project.updated_at ? new Date(project.updated_at).toLocaleDateString("ru") : "Не указано"}</dd>
            </div>
            <div>
              <dt>Лицензия</dt>
              <dd>{project.license || "Не указана"}</dd>
            </div>
            {project.type === "mod" && (
              <div>
                <dt>Идентификатор</dt>
                <dd>{project.package_id || "Не указан"}</dd>
              </div>
            )}
          </dl>
          <button
            type="button"
            className="secondary project-share-button"
            onClick={() => void writeText(`https://vlauncher.space/project/${project.slug}`)
              .then(() => {
                setLinkCopied(true);
                window.setTimeout(() => setLinkCopied(false), 1800);
              })
              .catch(() => setReportStatus("Не удалось скопировать ссылку"))}
          >
            {linkCopied ? "Ссылка скопирована" : "Скопировать ссылку на проект"}
          </button>
            </div>
            <aside className="project-install-panel">
              <h2>{standalone ? (installedModpackProfile ? "Профиль проекта" : "Создать профиль") : "Установка"}</h2>
          {releases.length ? (
            <>
              <div className={standalone ? "form-columns single" : "form-columns"}>
                <label>
                  Версия проекта
                  <Select
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                  >
                    {releases.map((r) => (
                      <option key={r.version} value={r.version}>
                        {r.version} ·{" "}
                        {r.channel === "stable" ? "Стабильная" : r.channel}
                        {r.deprecated ? " · устарела" : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                {!standalone && (
                  installableProfiles.length ? (
                    <label>
                      Установить в профиль
                      <Select
                        value={profile?.id ?? ""}
                        onChange={(e) => select(e.target.value)}
                      >
                        <option value="" disabled>
                          Выберите профиль
                        </option>
                        {installableProfiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name} · {engineVersion(p) ? versionLabel(engineVersion(p)) : "версия не выбрана"}
                          </option>
                        ))}
                      </Select>
                    </label>
                  ) : (
                    <div className="install-new-profile">
                      <span>Профиль</span>
                      <strong>Будет создан новый профиль</strong>
                    </div>
                  )
                )}
              </div>
              {standalone && (
                <div className="notice modpack-profile-notice">
                  <strong>{installedModpackProfile ? `Проект управляет профилем «${installedModpackProfile.name}»` : "Проект создаст отдельный профиль"}</strong>
                  <span>{project.type === "project" ? "Код и встроенный контент обновляются атомарно. Миры и настройки пользователя сохраняются отдельно." : installedModpackProfile ? "Выбранная версия VoxelCore и весь состав сборки обновятся одной операцией. Пользовательские дополнения сохранятся, если они совместимы." : "VoxelCore, контент и зависимости установятся автоматически. Существующие профили не изменятся."}</span>
                </div>
              )}
              {installedModpackProfile && (
                <p className="muted">
                  Профиль <strong>{installedModpackProfile.name}</strong> использует версию {installedModpack?.version}.
                </p>
              )}
              <div className="release-info">
                <span>VoxelCore {normalizeVersionRequirement(release?.voxelcore ?? "")}</span>
                <span>
                  {release?.artifact_size != null
                    ? formatBytes(release.artifact_size + releaseComponents.reduce((sum, item) => sum + item.artifact_size, 0))
                    : "Размер не указан"}
                </span>
              </div>
              {!standalone && profile && !engineVersion(profile) && (
                <p role="status">Перед установкой выберите версию VoxelCore в разделе «Управление» профиля.</p>
              )}
              {release?.deprecated && (
                <div className="notice">
                  Автор пометил эту версию как устаревшую.
                </div>
              )}
              {mainRequirement && !targetIsStable && (
                <div className="notice main-commit-requirement" role="status">
                  <strong>Экспериментальная версия VoxelCore</strong>
                  <span>
                    {createsProjectProfile
                      ? `Нажмите «Создать профиль и установить» — лаунчер подберёт и скачает официальную DEV-сборку VoxelCore ${formatVoxelCoreVersion(mainRequirement.target_version)}.`
                      : `После выбора профиля лаунчер подберёт и скачает официальную DEV-сборку VoxelCore ${formatVoxelCoreVersion(mainRequirement.target_version)}.`}
                  </span>
                  {!mainlineStatus.enabled && (
                    <button type="button" onClick={openExperimentalSettings}>
                      Включить DEV-сборки
                    </button>
                  )}
                </div>
              )}
              {release?.changelog && (
                <details>
                  <summary>Изменения в версии {release.version}</summary>
                  <p className="preserve-lines">{release.changelog}</p>
                </details>
              )}
              {!standalone && !!release?.dependencies?.length && (
                <section className="release-dependencies">
                  <h3>Зависимости</h3>
                  {release.dependencies.map((dependency) => (
                    <div key={`${dependency.kind}-${dependency.id}`} className="dependency-card">
                      <div className="dependency-card-heading">
                        {isVoxelCoreBuiltin(dependency.id) ? (
                          <strong>{dependency.id}</strong>
                        ) : (
                          <button className="dependency-project-link" onClick={() => inspect({ source: "vspace", slug: dependency.id, requirement: dependency.requirement, relation: dependency.kind, parent: project.title, engine: engineVersion(profile) })}>
                            {dependency.id}
                          </button>
                        )}
                        <span>{dependencyKindLabel(dependency.kind)}</span>
                      </div>
                      <footer>
                        <span>{isVoxelCoreBuiltin(dependency.id) ? "VoxelCore · встроенный пакет" : "VSpace"}</span>
                        <code>{dependency.requirement}</code>
                      </footer>
                    </div>
                  ))}
                </section>
              )}
              {project.type === "modpack" && !!releaseComponents.length && (
                <section className="release-dependencies">
                  <h3>Стартовые карты</h3>
                  {releaseComponents.map((component) => (
                    <div key={component.key} className="dependency-card">
                      <div className="dependency-card-heading">
                        <strong>{component.title}</strong>
                        <span>{formatBytes(component.artifact_size)}</span>
                      </div>
                      <footer>
                        <span>Копируется в новый профиль один раз</span>
                        <span>{component.dependencies.length ? `${component.dependencies.length} зависимостей` : "Без дополнительных зависимостей"}</span>
                      </footer>
                    </div>
                  ))}
                </section>
              )}
              {!!release?.attestation?.assertion?.manifest?.capabilities
                ?.length && (
                  <div className="notice">
                    Разрешения пакета:{" "}
                    {release.attestation.assertion!.manifest.capabilities.join(
                      ", ",
                    )}
                  </div>
                )}
              {!standalone && installed && (
                <p className="muted">
                  В выбранном профиле установлена версия {installed.version}.
                </p>
              )}
              {!standalone && manualCollision && (
                <ErrorNotice>
                  В папке уже есть добавленный вручную пакет <strong>{project.package_id}</strong>. Переместите или переименуйте его и повторите установку.
                </ErrorNotice>
              )}
              {!standalone && profile && running.has(profile.id) && (
                <div className="notice">
                  Завершите игру, чтобы изменить её контент.
                </div>
              )}
              {standalone && installedModpackProfile && running.has(installedModpackProfile.id) && (
                <div className="notice">Завершите игру в профиле «{installedModpackProfile.name}», чтобы обновить сборку.</div>
              )}
              {failed && (
                <ErrorNotice>
                  Не удалось подобрать зависимости. Причина записана в журнале.
                </ErrorNotice>
              )}
              {reportToken && (
                <details className="report-project">
                  <summary>Пожаловаться на проект</summary>
                  <textarea
                    aria-label="Описание жалобы"
                    minLength={10}
                    maxLength={10000}
                    placeholder="Опишите проблему подробно"
                    value={reportDetails}
                    onChange={(event) => setReportDetails(event.target.value)}
                  />
                  <button
                    disabled={busy || reportDetails.trim().length < 10}
                    onClick={() =>
                      void createReport(reportToken, project.slug, "other", reportDetails.trim())
                        .then(() => {
                          setReportDetails("");
                          setReportStatus("Жалоба отправлена модераторам");
                        })
                        .catch((reason) => setReportStatus(String(reason)))
                    }
                  >
                    Отправить жалобу
                  </button>
                  {reportStatus && <small>{reportStatus}</small>}
                </details>
              )}
              <div className="modal-actions">
                {installedModpackProfile && selectedModpackIsInstalled ? (
                  <button
                    className="primary"
                    onClick={() => openProfile(installedModpackProfile.id)}
                  >
                    Открыть профиль · {installedModpackProfile.name}
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      (!standalone && !createsProjectProfile && (!profile || !engineVersion(profile))) ||
                      (standalone && !exactVoxelCoreVersion(release?.voxelcore ?? "")) ||
                      (standalone && !!installedModpackProfile && running.has(installedModpackProfile.id)) ||
                      (!standalone && manualCollision) ||
                      (!standalone && !!profile && running.has(profile.id)) ||
                      !release?.download_url
                    }
                    onClick={install}
                  >
                    {busy
                      ? "Проверяем…"
                      : standalone
                        ? installedModpackProfile
                          ? `Обновить до ${version}`
                          : project.type === "project" ? "Установить проект" : "Установить сборку"
                        : createsProjectProfile
                          ? "Создать профиль и установить"
                          : "Посмотреть состав установки"}
                  </button>
                )}
              </div>
            </>
          ) : (
            <p className="notice">У проекта пока нет доступных релизов.</p>
          )}
            </aside>
          </div>
        </>
      )}
    </ProjectSurface>
  );
}
export function InstallPreview({
  mainBuild,
  profile,
  plan,
  title,
  newProfileName,
  busy,
  task,
  close,
  apply,
  skipVersion,
}: Preview & {
  busy: boolean;
  task?: Task;
  close: () => void;
  apply: () => Promise<boolean>;
  skipVersion?: (id: string, version: string) => Promise<boolean>;
}) {
  const versionLabel = useVoxelCoreVersionLabel();
  const inspect = useContentInspector();
  const [failed, setFailed] = useState(false);
  const [acceptedMainRisk, setAcceptedMainRisk] = useState(false);
  const modpack = plan.plan.packages.find((pkg) => pkg.type === "modpack" || pkg.type === "project");
  const installedModpack = modpack
    ? profile.packages.find((pkg) => pkg.id === modpack.id && (pkg.kind === "modpack" || pkg.kind === "project"))
    : undefined;
  const modpackChanged = !!modpack && installedModpack?.version !== modpack.version;
  const contentPackages = plan.plan.packages.filter((pkg) => pkg.type !== "modpack" && pkg.type !== "project");
  const changes = contentPackages.map((pkg) => {
    const old = profile.packages.find((p) => p.id === pkg.id);
    return {
      id: pkg.id,
      title: pkg.title || pkg.id,
      version:
        old && old.version !== pkg.version
          ? `${old.version} → ${pkg.version}`
          : pkg.version,
      status: !old
        ? "Добавить"
        : old.version !== pkg.version
          ? "Изменить"
          : "Без изменений",
      dependency: !plan.plan.roots.includes(pkg.id),
      oldVersion: old?.version,
    };
  });
  for (const pkg of profile.packages.filter((pkg) => pkg.kind !== "modpack" && pkg.kind !== "project"))
    if (!contentPackages.some((p) => p.id === pkg.id))
      changes.push({ ...pkg, title: pkg.title || pkg.id, status: "Удалить", dependency: false, oldVersion: pkg.version });
  const externalChanges = (plan.plan.external_packages ?? []).map((pkg) => {
    const old = profile.external_packages?.find((item) => item.id === pkg.id);
    return {
      ...pkg,
      status: !old
        ? "Добавить"
        : old.version !== pkg.version || old.artifact_sha256 !== pkg.artifact_sha256
          ? "Изменить"
          : "Без изменений",
    };
  });
  if (plan.plan.external_packages)
    for (const pkg of profile.external_packages ?? [])
      if (!plan.plan.external_packages.some((item) => item.id === pkg.id))
        externalChanges.push({
          ...pkg,
          artifact_size: pkg.artifact_size ?? 0,
          status: "Удалить",
        });
  const changed =
    (!!mainBuild && mainBuild.artifact_id !== profile.main_build?.artifact_id) ||
    modpackChanged ||
    changes.some((c) => c.status !== "Без изменений") ||
    externalChanges.some((c) => c.status !== "Без изменений") ||
    JSON.stringify([...profile.roots].sort()) !==
    JSON.stringify([...plan.plan.roots].sort());
  return (
    <Modal title={title} close={close} busy={busy}>
      {mainBuild ? (
        <div className="notice main-commit-requirement">
          <strong>Лаунчер подготовит DEV-сборку автоматически</strong>
          <span>{mainBuildLabel(mainBuild)}. Если её ещё нет на компьютере, она будет скачана перед установкой мода.</span>
          {mainBuild.artifact_id !== profile.main_build?.artifact_id && (
            <label className="checkbox-row">
              <input type="checkbox" checked={acceptedMainRisk} onChange={(event) => setAcceptedMainRisk(event.target.checked)} />
              Понимаю, что DEV-сборка может содержать ошибки и повредить мир
            </label>
          )}
        </div>
      ) : profile.main_build && <p>Выбрана сборка main · {profile.main_build.sha.slice(0, 7)}. Некоторые пакеты могут с ней не работать.</p>}
      <p>
        {newProfileName ? "Будет создан профиль" : "Профиль"} <strong>{newProfileName || profile.name}</strong> · VoxelCore{" "}
        {versionLabel(plan.plan.voxelcore_version)}
      </p>
      {modpack && (
        <p className="install-modpack-version">
          Версия {modpack.type === "project" ? "проекта" : "сборки"} · {installedModpack && installedModpack.version !== modpack.version
            ? `${installedModpack.version} → ${modpack.version}`
            : modpack.version}
        </p>
      )}
      {!!modpack?.project_permissions?.length && (
        <div className="notice" role="status">
          <strong>Разрешения проекта</strong>
          <span>{modpack.project_permissions.join(", ")}</span>
        </div>
      )}
      {!!changes.length && (
        <div className="install-changes">
          {changes.map((c) => (
          <div key={c.id}>
            <div>
              {c.id.startsWith("__world_") ? (
                <strong>{c.title}</strong>
              ) : (
                <button className="dependency-project-link" onClick={() => inspect({ source: "vspace", slug: c.id, version: plan.plan.packages.find(pkg => pkg.id === c.id)?.version || c.oldVersion, parent: profile.name })}>{c.title}</button>
              )}
              <small>
                {c.id.startsWith("__world_") ? "Стартовая карта" : c.dependency ? "Зависимость" : "Выбранный пакет"} · {c.version}
              </small>
            </div>
            <div className="actions">
              {skipVersion &&
                c.status === "Изменить" &&
                !c.dependency &&
                c.oldVersion && (
                  <button
                    disabled={busy}
                    onClick={() => void skipVersion(c.id, c.oldVersion!)}
                  >
                    Оставить {c.oldVersion}
                  </button>
                )}
              <span className={c.status === "Удалить" ? "danger-text" : "muted"}>
                {c.status}
              </span>
            </div>
          </div>
          ))}
        </div>
      )}
      {!!externalChanges.length && (
        <>
          <h3>VoxelWorld</h3>
          <div className="install-changes">
            {externalChanges.map((item) => (
              <div key={`voxelworld-${item.id}`}>
                <div>
                  <button className="dependency-project-link" onClick={() => inspect({ source: item.source, slug: item.slug, title: item.title, version: item.version, versionId: item.version_id, parent: profile.name })}>{item.title}</button>
                  <small>{item.id} · {item.version} · зафиксированная версия</small>
                </div>
                <span className={item.status === "Удалить" ? "danger-text" : "muted"}>
                  {item.status}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="muted">
        Размер архивов:{" "}
        {formatBytes(
          plan.plan.packages.reduce((sum, p) => sum + p.artifact_size, 0) +
            (plan.plan.external_packages ?? []).reduce(
              (sum, p) => sum + p.artifact_size,
              0,
            ),
        )}
        . Часть файлов может быть в кэше.
      </p>
      {plan.plan.packages.some((p) => p.type === "world") && (
        <p>
          Карта появится в папке миров при следующем запуске. Уже созданные миры
          сохранятся.
        </p>
      )}
      {changes.some(
        (c) => c.status === "Удалить" || c.status === "Изменить",
      ) && (
          <div className="notice">
            Существующие миры могут зависеть от этих версий пакетов. Перед
            изменением сохраните копию папки миров.
          </div>
        )}
      {!changed && (
        <div className="notice success">Состав профиля уже актуален.</div>
      )}
      {failed && (
        <ErrorNotice>
          Установка не завершена. Подробности в журнале. Можно повторить
          попытку.
        </ErrorNotice>
      )}
      {busy && (
        <div className="notice install-progress" role="status" aria-live="polite">
          <strong>{task?.title ?? "Установка"}</strong>
          <span>{task?.detail ?? "Подготовка…"}</span>
          {!!task?.total && (
            <progress
              max={task.total}
              value={Math.min(task.completed ?? 0, task.total)}
              aria-label="Прогресс загрузки"
            />
          )}
          <small>Профиль изменится только после успешной проверки всего набора.</small>
        </div>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={close}>
          {changed ? "Отмена" : "Закрыть"}
        </button>
        {changed && (
          <button
            className="primary"
            disabled={busy || (!!mainBuild && mainBuild.artifact_id !== profile.main_build?.artifact_id && !acceptedMainRisk)}
            onClick={() => void apply().then((ok) => setFailed(!ok))}
          >
            {busy ? "Устанавливаем…" : newProfileName ? "Создать и установить" : "Применить изменения"}
          </button>
        )}
      </div>
    </Modal>
  );
}
