import { recordContent } from "../telemetry";
import { PrivateImage } from "./PrivateImage";
import { useRegistryResource } from "../useResource";
import { CatalogSkeleton } from "./ui";
import { CategoryFilter } from "./CategoryFilter";
import { Markdown } from "./Markdown";
import { popupMenu, contextMenuPosition } from "../desktop";
import { Select } from "./Select";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type CategoryOption,
  createReport,
  resolveProject,
  type Project,
  type ProjectDetail,
  type Release,
  type SignedInstallPlan,
} from "../api";
import {
  engineVersion,
  formatBytes,
  kinds,
  type LocalProfile,
  type RunTask,
} from "../model";
import { Empty, ErrorNotice, Icon, Modal } from "./ui";
import { useJointCatalogEnabled } from "../experimental";
import { catalogProjectKeys } from "../catalogIdentity";
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
  profile: LocalProfile;
  plan: SignedInstallPlan;
  title: string;
  coverUrl?: string;
};
type CatalogSource = "all" | "vspace" | "voxelworld";
type CatalogItem = {
  key: string;
  source: "vspace" | "voxelworld";
  slug: string;
  title: string;
  summary: string;
  downloads: number;
  updatedAt: string;
  footer: string;
  project?: Project;
  voxelWorld?: VoxelWorldMod;
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
  create,
  refreshProfiles,
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
  create: () => void;
  refreshProfiles: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("mod");
  const jointCatalogEnabled = useJointCatalogEnabled();
  const jointCatalog = jointCatalogEnabled && kind === "mod";
  const [source, setSource] = useState<CatalogSource>("all");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState("updated");
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [category, setCategory] = useState<string[]>([]);
  const [detail, setDetail] = useState("");
  const [search, setSearch] = useState(query);
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 200); return () => clearTimeout(timer); }, [query]);
  const catalogEngine = engineVersion(profiles.find(p => p.id === selected));
  const params = new URLSearchParams({ limit: "24", offset: String(offset), sort, kind });
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
        key: `vspace:${project.slug}`,
        source: "vspace",
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
        source: "voxelworld",
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
    key: `vspace:${project.slug}`,
    source: "vspace",
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
  const refresh = () => {
    if (jointCatalog) {
      allVSpace.refresh();
      allVoxelWorld.refresh();
    } else result.refresh();
  };
  const setRetry = (_: unknown) => { refresh(); categoryResult.refresh(); voxelWorldTags.refresh(); };
  useEffect(() => { if (deepLink && active) setDetail(deepLink); }, [deepLink, active]);
  useEffect(() => { if (!active) setDetail(""); }, [active]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Каталог</h1>
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
          {catalogEngine ? `Только совместимые с VoxelCore ${catalogEngine}` : "Для проверки совместимости выберите профиль с версией VoxelCore"}
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
              ? `Для VoxelCore ${catalogEngine} ничего не найдено. Можно выключить фильтр совместимости.`
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
              <button
                className="catalog-card"
                disabled={updating}
                key={project.key}
                onClick={() => setDetail(project.source === "voxelworld" ? `voxelworld:${project.slug}` : project.slug)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void popupMenu([
                    { text: "Открыть проект", action: () => setDetail(project.source === "voxelworld" ? `voxelworld:${project.slug}` : project.slug) },
                    ...(project.source === "voxelworld"
                      ? [{ text: "Открыть на VoxelWorld", action: () => void openUrl(`https://voxelworld.ru/mods/${encodeURIComponent(project.slug)}`) }]
                      : [{ text: "Версии и установка…", action: () => setDetail(project.slug) }]),
                  ], contextMenuPosition(event));
                }}
              >
                <div className="catalog-card-top">
                  {project.project ? <ProjectIcon project={project.project} /> : <ExternalProjectIcon project={project.voxelWorld!} />}
                  <div>
                    <span className="eyebrow supporting-label">
                      Контент-пак{jointCatalog ? ` · ${project.source === "vspace" ? "VSpace" : "VoxelWorld"}` : ""}
                    </span>
                    <h2>{project.title}</h2>
                  </div>
                </div>
                <p>{project.summary || "Автор пока не добавил описание."}</p>
                <footer>
                  <span>{project.footer}</span>
                  <span>
                    <Icon name="download" size={14} />
                    {project.downloads.toLocaleString("ru")}
                  </span>
                </footer>
              </button>
            ))}
          </div>
          <div className="pagination">
            <span>
              {offset + 1}–{offset + page.items.length} из {page.total}
            </span>
            <div className="actions">
              <button
                disabled={offset === 0}
                onClick={() => setOffset((n) => Math.max(0, n - 24))}
              >
                Назад
              </button>
              <button
                disabled={offset + 24 >= page.total}
                onClick={() => setOffset((n) => n + 24)}
              >
                Далее
              </button>
            </div>
          </div>
        </>
      )}
      {detail && (
        detail.startsWith("voxelworld:") ? (
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
            close={() => setDetail("")}
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
            close={() => setDetail("")}
            create={create}
          />
        )
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
function ProjectIcon({ project }: { project: Project }) {
  const image = project.cover_url || project.latest_release?.preview_url;
  return image ? (
    <PrivateImage
      className="project-icon"
      src={image}
      alt=""
      fallback={<span className="project-icon"><Icon name="package" size={26} /></span>}
    />
  ) : (
    <span className={`project-icon ${project.type}`}>
      <Icon name={project.type === "world" ? "world" : "package"} size={26} />
    </span>
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
  const result = useVoxelWorldMod(slug);
  const project = result.data;
  const versionsResult = useVoxelWorldVersions(slug);
  const versions = versionsResult.data ?? [];
  const profile = profiles.find((item) => item.id === selected);
  const profileEngine = engineVersion(profile);
  const [versionId, setVersionId] = useState(0);
  const [acceptedRisk, setAcceptedRisk] = useState(false);
  const [allowIncompatible, setAllowIncompatible] = useState(false);
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
  const install = () => {
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
  return (
    <Modal title={project?.title ?? "Проект VoxelWorld"} close={close} busy={busy}>
      {result.error && !project ? (
        <ErrorNotice retry={result.refresh}>{result.error}</ErrorNotice>
      ) : !project ? (
        <div className="loading">Загружаем описание…</div>
      ) : (
        <>
          {result.error && <ErrorNotice retry={result.refresh}>Не удалось обновить данные. Показана сохранённая карточка.</ErrorNotice>}
          <div className="project-detail-title">
            <ExternalProjectIcon project={project} />
            <div>
              <span>Контент-пак · VoxelWorld · {project.author.name}</span>
              <p>{project.description}</p>
            </div>
          </div>
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
                    onChange={(event) => {
                      setVersionId(Number(event.target.value));
                      setAcceptedRisk(false);
                      setAllowIncompatible(false);
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
                    value={selected}
                    onChange={(event) => {
                      select(event.target.value);
                      setAcceptedRisk(false);
                      setAllowIncompatible(false);
                    }}
                    disabled={!profiles.length}
                  >
                    <option value="" disabled>Выберите профиль</option>
                    {profiles.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {engineVersion(item) || "версия не выбрана"}
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
                  <h3>Будут установлены зависимости</h3>
                  {versionDetail.dependencies.map((dependency) => (
                    <div className="dependency-row" key={`${dependency.project.id}-${dependency.id}`}>
                      <strong>{dependency.project.title}</strong>
                      <span>{dependency.version_number}</span>
                      <small>VoxelWorld</small>
                    </div>
                  ))}
                </section>
              )}
              {versionResult.loading && <p role="status">Проверяем зависимости…</p>}
              {versionResult.error && (
                <ErrorNotice retry={versionResult.refresh}>Не удалось проверить зависимости выбранной версии.</ErrorNotice>
              )}
              {profile && !profileEngine && <ErrorNotice>В профиле не выбрана версия VoxelCore.</ErrorNotice>}
              {profileEngine && selectedVersion && !compatible && (
                <>
                  <ErrorNotice>Эта версия не поддерживает VoxelCore {profileEngine}.</ErrorNotice>
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={allowIncompatible}
                      onChange={(event) => setAllowIncompatible(event.target.checked)}
                    />
                    Установить всё равно. Мод может не запуститься или повредить данные мира
                  </label>
                </>
              )}
              {profile && running.has(profile.id) && <div className="notice">Завершите игру, чтобы изменить её контент.</div>}
              <label className="checkbox-row external-install-consent">
                <input
                  type="checkbox"
                  checked={acceptedRisk}
                  onChange={(event) => setAcceptedRisk(event.target.checked)}
                />
                Архивы загружаются с VoxelWorld и не имеют опубликованной подписи или контрольной суммы
              </label>
            </>
          ) : (
            <p className="notice">У проекта пока нет доступных версий.</p>
          )}
          <div className="modal-actions">
            <button onClick={close}>Закрыть</button>
            <button onClick={openProject}>Открыть на VoxelWorld</button>
            {!!versions.length && (
              <button
                className="primary"
                disabled={
                  busy ||
                  !profile ||
                  !profileEngine ||
                  !selectedVersion ||
                  !versionDetail ||
                  (!compatible && !allowIncompatible) ||
                  !acceptedRisk ||
                  running.has(profile.id)
                }
                onClick={install}
              >
                {profile?.external_packages?.some((item) => item.project_id === project.id)
                  ? "Обновить"
                  : "Установить"}
              </button>
            )}
          </div>
        </>
      )}
    </Modal>
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
  create,
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
  create: () => void;
}) {
  const projectResult = useRegistryResource<ProjectDetail>(`/projects/${encodeURIComponent(slug)}`);
  const releasesResult = useRegistryResource<Release[]>(`/projects/${encodeURIComponent(slug)}/releases`);
  const project = projectResult.data;
  useEffect(() => { if (project) recordContent(slug, "view"); }, [slug, !!project]);
  const releases = releasesResult.data ?? [];
  const [version, setVersion] = useState("");
  const retryDetails = () => { projectResult.refresh(); releasesResult.refresh(); };
  const [failed, setFailed] = useState(false);
  const [reportToken, setReportToken] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [reportStatus, setReportStatus] = useState("");
  useEffect(() => {
    void invoke<string | null>("load_access_token")
      .then((value) => setReportToken(value ?? ""))
      .catch(() => { });
  }, []);
  useEffect(() => {
    if (releasesResult.data) setVersion(current => releasesResult.data!.some(r => r.version === current) ? current : (releasesResult.data!.find(r => r.channel === 'stable' && !r.deprecated)?.version ?? releasesResult.data![0]?.version ?? ""));
  }, [releasesResult.data]);
  const release = releases.find((r) => r.version === version);
  const profile = profiles.find((p) => p.id === selected);
  const installed = profile?.packages.find((p) => p.id === slug);
  const manualCollision = profile?.manual_packages?.includes(slug) ?? false;
  const install = () => {
    if (!profile || !release || !project) return;
    void run(`Проверка · ${project.title}`, async () => {
      const roots =
        project.type === "modpack"
          ? [slug]
          : [...new Set([...profile.roots, slug])];
      const requirements =
        project.type === "modpack"
          ? { [slug]: `=${version}` }
          : { ...(profile.root_requirements ?? {}), [slug]: `=${version}` };
      const plan = await resolveProject(
        roots,
        engineVersion(profile),
        requirements,
        release.channel === "stable" ? ["stable"] : ["stable", release.channel],
      );
      preview({ profile, plan, title: `Установка ${project.title}`, coverUrl: project.type === "modpack" ? project.cover_url ?? undefined : undefined });
      close();
    }).then((ok) => setFailed(!ok));
  };
  return (
    <Modal title={project?.title ?? "Проект"} close={close} busy={busy}>
      {projectResult.error && !project ? (
        <ErrorNotice retry={retryDetails}>{projectResult.error}</ErrorNotice>
      ) : !project ? (
        <div className="loading">Загружаем описание…</div>
      ) : (
        <>
          {(projectResult.error || releasesResult.error) && <ErrorNotice retry={retryDetails}>Не удалось обновить данные проекта. Повторите перед установкой.</ErrorNotice>}
          {releasesResult.loading && <p role="status">Загружаем версии…</p>}
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
          <dl className="metadata">
            <div>
              <dt>Лицензия</dt>
              <dd>{project.license || "Не указана"}</dd>
            </div>
            <div>
              <dt>Идентификатор</dt>
              <dd>{project.slug}</dd>
            </div>
          </dl>
          {releases.length ? (
            <>
              <div className="form-columns">
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
                <label>
                  Установить в профиль
                  <Select
                    value={selected}
                    onChange={(e) => select(e.target.value)}
                    disabled={!profiles.length}
                  >
                    <option value="" disabled>
                      Выберите профиль
                    </option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} · {engineVersion(p) || "версия не выбрана"}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <div className="release-info">
                <span>VoxelCore {release?.voxelcore}</span>
                <span>
                  {release?.artifact_size != null
                    ? formatBytes(release.artifact_size)
                    : "Размер не указан"}
                </span>
              </div>
              {profile && !engineVersion(profile) && (
                <p role="status">Перед установкой выберите версию VoxelCore в разделе «Управление» профиля.</p>
              )}
              {release?.deprecated && (
                <div className="notice">
                  Автор пометил эту версию как устаревшую.
                </div>
              )}
              {release?.changelog && (
                <details>
                  <summary>Изменения в версии {release.version}</summary>
                  <p className="preserve-lines">{release.changelog}</p>
                </details>
              )}
              {!!release?.dependencies?.length && (
                <section className="release-dependencies">
                  <h3>Связи пакета</h3>
                  {release.dependencies.map((dependency) => (
                    <div key={`${dependency.kind}-${dependency.id}`} className="dependency-row">
                      <strong>{dependency.id}</strong>
                      <span>{dependency.requirement}</span>
                      <small>
                        {dependency.kind === "required"
                          ? "обязательная"
                          : dependency.kind === "optional"
                            ? "необязательная"
                            : dependency.kind === "conflict"
                              ? "конфликт"
                              : "слабая"}
                      </small>
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
              {installed && (
                <p className="muted">
                  В выбранном профиле установлена версия {installed.version}.
                </p>
              )}
              {manualCollision && (
                <ErrorNotice>
                  В папке уже есть добавленный вручную пакет <strong>{slug}</strong>. Переместите или переименуйте его и повторите установку.
                </ErrorNotice>
              )}
              {profile && running.has(profile.id) && (
                <div className="notice">
                  Завершите игру, чтобы изменить её контент.
                </div>
              )}
              {failed && (
                <ErrorNotice>
                  Не удалось подобрать зависимости. Причина записана в журнале.
                </ErrorNotice>
              )}
              <div className="modal-actions">
                <button onClick={close} disabled={busy}>
                  Закрыть
                </button>
                {!profiles.length ? (
                  <button
                    className="primary"
                    onClick={() => {
                      close();
                      create();
                    }}
                  >
                    Создать профиль
                  </button>
                ) : (
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !profile ||
                      !engineVersion(profile) ||
                      manualCollision ||
                      running.has(profile.id) ||
                      !release?.download_url
                    }
                    onClick={install}
                  >
                    {busy ? "Проверяем…" : "Посмотреть состав установки"}
                  </button>
                )}
              </div>
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
            </>
          ) : (
            <p className="notice">У проекта пока нет доступных релизов.</p>
          )}
        </>
      )}
    </Modal>
  );
}
export function InstallPreview({
  profile,
  plan,
  title,
  busy,
  close,
  apply,
  skipVersion,
}: Preview & {
  busy: boolean;
  close: () => void;
  apply: () => Promise<boolean>;
  skipVersion?: (id: string, version: string) => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  const changes = plan.plan.packages.map((pkg) => {
    const old = profile.packages.find((p) => p.id === pkg.id);
    return {
      id: pkg.id,
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
  for (const pkg of profile.packages)
    if (!plan.plan.packages.some((p) => p.id === pkg.id))
      changes.push({ ...pkg, status: "Удалить", dependency: false, oldVersion: pkg.version });
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
    changes.some((c) => c.status !== "Без изменений") ||
    externalChanges.some((c) => c.status !== "Без изменений") ||
    JSON.stringify([...profile.roots].sort()) !==
    JSON.stringify([...plan.plan.roots].sort());
  return (
    <Modal title={title} close={close} busy={busy}>
      {profile.main_build && <p>Выбрана сборка main · {profile.main_build.sha.slice(0, 7)}. Некоторые пакеты могут с ней не работать.</p>}
      <p>
        Профиль <strong>{profile.name}</strong> · VoxelCore{" "}
        {plan.plan.voxelcore_version}
      </p>
      <div className="install-changes">
        {changes.map((c) => (
          <div key={c.id}>
            <div>
              <strong>{c.id}</strong>
              <small>
                {c.dependency ? "Зависимость" : "Выбранный пакет"} · {c.version}
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
      {!!externalChanges.length && (
        <>
          <h3>VoxelWorld</h3>
          <div className="install-changes">
            {externalChanges.map((item) => (
              <div key={`voxelworld-${item.id}`}>
                <div>
                  <strong>{item.title}</strong>
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
      <div className="modal-actions">
        <button disabled={busy} onClick={close}>
          {changed ? "Отмена" : "Закрыть"}
        </button>
        {changed && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => void apply().then((ok) => setFailed(!ok))}
          >
            {busy ? "Устанавливаем…" : "Применить изменения"}
          </button>
        )}
      </div>
    </Modal>
  );
}
