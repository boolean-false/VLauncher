import { recordContent } from "../telemetry";
import { PrivateImage } from "./PrivateImage";
import { useRegistryResource } from "../useResource";
import { CatalogSkeleton } from "./ui";
import { CategoryFilter } from "./CategoryFilter";
import { Markdown } from "./Markdown";
import { popupMenu, contextMenuPosition } from "../desktop";
import { Select } from "./Select";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

type Preview = {
  profile: LocalProfile;
  plan: SignedInstallPlan;
  title: string;
  coverUrl?: string;
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
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("mod");
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState("updated");
  const [compatibleOnly, setCompatibleOnly] = useState(false);
  const [category, setCategory] = useState<string[]>([]);
  const [detail, setDetail] = useState("");
  const [search, setSearch] = useState(query);
  useEffect(() => { const timer = setTimeout(() => setSearch(query), 200); return () => clearTimeout(timer); }, [query]);
  const catalogEngine = engineVersion(profiles.find(p => p.id === selected));
  const params = new URLSearchParams({limit:"24",offset:String(offset),sort,kind});
  if (search.trim()) params.set('q',search.trim());
  for (const id of category) params.append('category',id);
  if (compatibleOnly && catalogEngine) params.set('voxelcore_version',catalogEngine);
  const result = useRegistryResource<{items:Project[];total:number}>(`/projects?${params}`, undefined, active);
  const categoryResult = useRegistryResource<CategoryOption[]>(`/categories?${new URLSearchParams({kind})}`, undefined, active);
  const categories = categoryResult.data ?? [];
  const categoryError = categoryResult.error;
  const previous = useRef<typeof result.data>(undefined);
  if (result.data) previous.current = result.data;
  const page = result.data ?? previous.current ?? {items:[],total:0};
  const loading = result.loading && !previous.current;
  const updating = result.fetching || search !== query;
  const error = result.error;
  const setRetry = (_: unknown) => { result.refresh(); categoryResult.refresh(); };
  useEffect(() => { if (deepLink && active) setDetail(deepLink); }, [deepLink,active]);
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
        <CategoryFilter items={categories} value={category} onChange={next=>{setCategory(next);setOffset(0);}} />
        {categoryError && (
          <span className="category-error">
            Не удалось загрузить категории.
            <button onClick={() => setRetry(null)}>Повторить</button>
          </span>
        )}
      </div>
      {error && previous.current && <ErrorNotice retry={result.refresh}>Не удалось обновить каталог. Показаны ранее загруженные данные.</ErrorNotice>}
      <p className="catalog-refresh-status" role="status">{updating && !loading ? "Обновляем результаты…" : ""}</p>
      {error && !previous.current ? (
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
                disabled={updating || !result.data}
                key={project.slug}
                onClick={() => setDetail(project.slug)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  void popupMenu([
                    { text: "Открыть проект", action: () => setDetail(project.slug) },
                    { text: "Версии и установка…", action: () => setDetail(project.slug) },
                  ], contextMenuPosition(event));
                }}
              >
                <div className="catalog-card-top">
                  <ProjectIcon project={project} />
                  <div>
                    <span className="eyebrow supporting-label">{kinds[project.type]}</span>
                    <h2>{project.title}</h2>
                  </div>
                </div>
                <p>{project.summary || "Автор пока не добавил описание."}</p>
                <footer>
                  <span>
                    {project.latest_release
                      ? `v${project.latest_release.version}`
                      : "Нет релизов"}
                  </span>
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
      )}
    </>
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
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (releasesResult.data) setVersion(current => releasesResult.data!.some(r=>r.version === current) ? current : (releasesResult.data!.find(r=>r.channel === 'stable' && !r.deprecated)?.version ?? releasesResult.data![0]?.version ?? ""));
  }, [releasesResult.data]);
  const release = releases.find((r) => r.version === version);
  const profile = profiles.find((p) => p.id === selected);
  const installed = profile?.packages.find((p) => p.id === slug);
  const manualCollision = profile?.manual_packages?.includes(slug) ?? false;
  const install = () => {
    if (!profile || !release || !project) return;
    void run(`Проверка · ${project.title}`, async () => {
      const roots = [...new Set([...profile.roots, slug])];
      const plan = await resolveProject(
        roots,
        engineVersion(profile),
        { ...(profile.root_requirements ?? {}), [slug]: `=${version}` },
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
  const changed =
    changes.some((c) => c.status !== "Без изменений") ||
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
      <p className="muted">
        Размер архивов:{" "}
        {formatBytes(
          plan.plan.packages.reduce((sum, p) => sum + p.artifact_size, 0),
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
