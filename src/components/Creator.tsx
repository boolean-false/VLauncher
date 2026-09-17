import { TeamActions } from "./TeamActions";
import { FeedbackPanel } from "./FeedbackPanel";
import { useRegistryResource } from "../useResource";
import { registryRequest, invalidateRegistry, clearPrivateCache } from "../api";
import { ProjectLifecycleActions } from "./ProjectLifecycleActions";
import { ProjectMediaEditor } from "./ProjectMediaEditor";
import { ImageEditor } from "./ImageEditor";
import { MarkdownEditor } from "./Markdown";
import { markdownImage } from "../markdownImage";
import { registryMediaUrl } from "../mediaUrl";
import { ManifestContentLinks } from "./ManifestContentLinks";
import { PrivateImage } from "./PrivateImage";
import { Icon, Modal, ErrorNotice, type IconName } from "./ui";
import { ProjectAnalytics } from "./ProjectAnalytics";
import { PlatformAdmin } from "./PlatformAdmin";
import { CategoryPicker } from "./CategoryPicker";
import { Select } from "./Select";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  assignOrganization,
  createCreatorProject,
  createOrganization,
  deprecateRelease,
  loadAccount,
  loadCreatorProjects,
  loadCreatorReleases,
  loadOrganizations,
  loadProjectMedia,
  loadProjectMembers,
  loadSessions,
  loadUpload,
  removeProjectMember,
  registryUrl,
  revokeSession,
  revokeSessionById,
  setProjectMember,
  updateCreatorProject,
  uploadProjectMedia,
  deleteProjectMedia,
  yankRelease,
  type Account,
  type AccessSession,
  type CreatorProject,
  type CreatorRelease,
  type DeviceSession,
  type Organization,
  type Project,
  type ProjectMedia,
  type ProjectMember,
} from "../api";
import { formatBytes, friendlyError, profileModpack, type LocalProfile } from "../model";
const storedToken = () => invoke<string | null>("load_access_token");
const draftStorageKey = (kind: "project" | "release") =>
  `vlauncher.creator.${kind}-draft:${registryUrl.replace(/\/$/, "")}`;
type PreparedArtifact = {
  path: string;
  sha256: string;
  size: number;
  manifest: {
    id: string;
    type: Project["type"] | "library";
    version: string;
    title: string;
    voxelcore: string;
    capabilities?: string[];
    dependencies?: unknown[];
    conflicts?: unknown[];
    external_packages?: unknown[];
    components?: { key: string; type: "world"; title: string }[];
  };
};
type LocalWorld = {
  folder: string;
  name: string;
  origin_title?: string;
  origin_version?: string;
  bundled: boolean;
  modified: number;
  voxelcore_version?: string;
  compatible?: boolean;
};
type GithubReleaseAsset = {
  id: number;
  name: string;
  size: number;
  download_count: number;
};
type GithubRelease = {
  id: number;
  name: string;
  tag_name: string;
  body: string;
  prerelease: boolean;
  published_at: string;
  assets: GithubReleaseAsset[];
};
type GithubReleasePage = {
  repository: string;
  releases: GithubRelease[];
  has_more: boolean;
};
const delay = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const readDraft = <T,>(key: string, fallback: T): T => {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) || "{}") };
  } catch {
    return fallback;
  }
};
const tokenSessionId = (token: string) => {
  try {
    return JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ).jti as string;
  } catch {
    return "";
  }
};

export function Creator({
  active = true,
  worldPublish,
}: {
  active?: boolean;
  worldPublish?: { profileId: string; folder: string } | null;
}) {
  const [section, setSection] = useState("projects");
  const [working, setWorking] = useState(false);
  const alive = useRef(true);
  const loginAttempt = useRef(0);
  const savedProjects = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      loginAttempt.current++;
    };
  }, []);
  const perform = async (task: () => Promise<unknown>) => {
    if (working) return;
    setWorking(true);
    try {
      await task();
    } catch (reason) {
      setError(String(reason));
    } finally {
      if (alive.current) setWorking(false);
    }
  };

  const [token, setToken] = useState("");
  const [tokenReady,setTokenReady] = useState(false);
  const tokenRef = useRef(token); tokenRef.current = token;
  const lastRefresh = useRef(0);
  useEffect(()=>{const clear=(event:Event)=>{if((event as CustomEvent).detail===tokenRef.current){setToken("");setAccount(null);setProjects([]);setSessions([]);setOrganizations([]);}};window.addEventListener('image-session-cleared',clear);return()=>window.removeEventListener('image-session-cleared',clear);},[]);
  const [account, setAccount] = useState<Account | null>(null);
  const [sessions, setSessions] = useState<AccessSession[]>([]);
  const [projects, setProjects] = useState<CreatorProject[]>([]);
  const [releases, setReleases] = useState<CreatorRelease[]>([]);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [lifecycleDialog, setLifecycleDialog] = useState<{
    release: CreatorRelease;
    action: "yank" | "deprecate";
  } | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");
  const [pendingProject, setPendingProject] = useState<string | null>(null);
  const [projectTab, setProjectTab] = useState("manage");
  const [showArchived, setShowArchived] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [deviceCode, setDeviceCode] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    setStatus("");
    setError("");
  }, [section]);
  const emptyProjectDraft: {
    type: Exclude<Project["type"], "runtime">;
    title: string;
    summary: string;
    description: string;
    license: string;
    categories: string[];
  } = {
    type: "mod" as const,
    title: "",
    summary: "",
    description: "",
    license: "",
    categories: [] as string[],
  };
  const [draft, setDraft] = useState(() =>
    (() => {
      const saved = readDraft(
        draftStorageKey("project"),
        emptyProjectDraft,
      );
      const savedType: Exclude<Project["type"], "runtime"> =
        saved.type === "modpack" || saved.type === "world"
          ? saved.type
          : "mod";
      return {
        ...saved,
        type: savedType,
      };
    })(),
  );
  const [organizationDraft, setOrganizationDraft] = useState({
    slug: "",
    name: "",
    description: "",
  });
  const releaseDraft = readDraft(draftStorageKey("release"), {
    folder: "",
    selectedProject: "",
    channel: "stable",
    changelog: "",
    source: "local",
    githubRepository: "",
  });
  const [folder, setFolder] = useState(releaseDraft.folder);
  const [selectedProject, setSelectedProject] = useState(
    releaseDraft.selectedProject,
  );
  const [channel, setChannel] = useState(releaseDraft.channel);
  const [changelog, setChangelog] = useState(releaseDraft.changelog);
  const [releaseSource, setReleaseSource] = useState<"local" | "github">(
    releaseDraft.source === "github" ? "github" : "local",
  );
  const [githubRepository, setGithubRepository] = useState(releaseDraft.githubRepository);
  const [githubReleases, setGithubReleases] = useState<GithubRelease[]>([]);
  const [githubPage, setGithubPage] = useState(0);
  const [githubHasMore, setGithubHasMore] = useState(false);
  const [githubTask, setGithubTask] = useState<"" | "releases" | "archive">("");
  const [preparedSource, setPreparedSource] = useState<{
    repository: string;
    release: string;
    archive: string;
  } | null>(null);
  const [prepared, setPrepared] = useState<PreparedArtifact | null>(null);
  const [member, setMember] = useState("");
  const [memberRole, setMemberRole] = useState<"maintainer" | "member">(
    "maintainer",
  );
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [media, setMedia] = useState<ProjectMedia[]>([]);
  const [localProfiles, setLocalProfiles] = useState<LocalProfile[]>([]);
  const [modpackProfile, setModpackProfile] = useState("");
  const [modpackWorlds, setModpackWorlds] = useState<LocalWorld[]>([]);
  const [selectedModpackWorlds, setSelectedModpackWorlds] = useState<string[]>([]);
  const [modpackWorldsLoading, setModpackWorldsLoading] = useState(false);
  const [modpackVersion, setModpackVersion] = useState("1.0.0");
  const [worldVersion, setWorldVersion] = useState("1.0.0");
  const [worldProfile, setWorldProfile] = useState("");
  const [worldFolder, setWorldFolder] = useState("");
  const [worlds, setWorlds] = useState<LocalWorld[]>([]);
  const [worldsLoading, setWorldsLoading] = useState(false);
  const [worldSelectionPending, setWorldSelectionPending] = useState(false);
  const selectedProjectType = projects.find((project) => project.slug === selectedProject)?.type;
  const [transfer, setTransfer] = useState<{
    completed: number;
    total: number;
    bytes_per_second: number;
    eta_seconds: number;
  } | null>(null);

  useEffect(() => {
    if (selectedProjectType !== "mod") setPreparedSource(null);
  }, [selectedProjectType]);

  useEffect(() => {
    if (worldPublish) {
      setSection("release");
      setWorldSelectionPending(true);
      setWorldProfile(worldPublish.profileId);
      setWorldFolder(worldPublish.folder);
      setStatus(
        `Карта «${worldPublish.folder}» выбрана для публикации.`,
      );
    }
  }, [worldPublish]);
  useEffect(() => {
    if (!worldSelectionPending) return;
    const selected = projects.find((project) => project.slug === selectedProject);
    const target = selected?.type === "world"
      ? selected
      : projects.find((project) => project.type === "world" && !project.archived_at);
    if (!target) return;
    if (target.slug !== selectedProject) {
      setSelectedProject(target.slug);
      setPrepared(null);
    }
    setWorldSelectionPending(false);
  }, [projects, selectedProject, worldSelectionPending]);
  useEffect(() => {
    void invoke<LocalProfile[]>("list_profiles")
      .then((items) => {
        setLocalProfiles(items);
        setModpackProfile((value) => value || items[0]?.id || "");
        setWorldProfile((value) => value || items[0]?.id || "");
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!modpackProfile) {
      setModpackWorlds([]);
      setSelectedModpackWorlds([]);
      return;
    }
    let current = true;
    setModpackWorldsLoading(true);
    void invoke<LocalWorld[]>("list_worlds", { profileId: modpackProfile })
      .then((items) => {
        if (!current) return;
        setModpackWorlds(items);
        setSelectedModpackWorlds((selected) =>
          selected.filter((folder) => items.some((world) => world.folder === folder)),
        );
      })
      .catch((reason) => {
        if (current) {
          setModpackWorlds([]);
          setSelectedModpackWorlds([]);
          setError(friendlyError(reason));
        }
      })
      .finally(() => {
        if (current) setModpackWorldsLoading(false);
      });
    return () => { current = false; };
  }, [modpackProfile]);
  useEffect(() => {
    if (selectedProjectType !== "world" && !worldSelectionPending) return;
    if (!worldProfile) {
      setWorlds([]);
      setWorldFolder("");
      return;
    }
    let current = true;
    setWorldsLoading(true);
    void invoke<LocalWorld[]>("list_worlds", { profileId: worldProfile })
      .then((items) => {
        if (!current) return;
        setWorlds(items);
        setWorldFolder((value) => items.some((world) => world.folder === value) ? value : items[0]?.folder || "");
      })
      .catch((reason) => {
        if (current) {
          setWorlds([]);
          setWorldFolder("");
          setError(friendlyError(reason));
        }
      })
      .finally(() => {
        if (current) setWorldsLoading(false);
      });
    return () => { current = false; };
  }, [selectedProjectType, worldProfile, worldSelectionPending]);
  useEffect(() => {
    const subscription = listen<typeof transfer>(
      "transfer-progress",
      (event) => {
        if (event.payload) setTransfer(event.payload);
      },
    );
    return () => {
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(
      draftStorageKey("project"),
      JSON.stringify(draft),
    );
  }, [draft]);
  useEffect(() => {
    localStorage.setItem(
      draftStorageKey("release"),
      JSON.stringify({
        folder,
        selectedProject,
        channel,
        changelog,
        source: releaseSource,
        githubRepository,
      }),
    );
  }, [folder, selectedProject, channel, changelog, releaseSource, githubRepository]);

  const refresh = useCallback(async (value: string) => {
    lastRefresh.current = Date.now();
    const [current, owned, ownOrganizations] =
      await Promise.all([
        loadAccount(value),
        loadCreatorProjects(value),
        loadOrganizations(value),
      ]);
    if (tokenRef.current !== value) return;
    lastRefresh.current = Date.now();
    setAccount(current);
    setProjects(owned);
    savedProjects.current = new Map(
      owned.map((project) => [project.slug, JSON.stringify(project)]),
    );
    setOrganizations(ownOrganizations);
    setSelectedProject((selected) =>
      owned.some((project) => project.slug === selected)
        ? selected
        : owned[0]?.slug || "",
    );
    setError("");
  }, []);

  useEffect(() => {
    void (async () => {
      // Старый токен не привязан к адресу сервера.
      localStorage.removeItem("vlauncher_token");
      setToken((await storedToken()) ?? "");
    })().catch((reason) => setError(String(reason))).finally(()=>setTokenReady(true));
  }, []);
  useEffect(() => {
    if (token)
      void refresh(token).catch((reason) => {
        setError(String(reason));
      });
  }, [token, refresh]);
  useEffect(()=>{if(!active||!token||section!=="sessions")return;let alive=true;void loadSessions(token).then(value=>{if(alive)setSessions(value);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[active,token,section]);
  const selectedProjectExists = projects.some(
    (project) => project.slug === selectedProject,
  );
  const projectPath = `/creator/projects/${encodeURIComponent(selectedProject)}`;
  const projectActive = active && !!token && selectedProjectExists;
  const releaseData = useRegistryResource<CreatorRelease[]>(`${projectPath}/releases`,token,projectActive && (section === "release" || section === "manage" && projectTab === "versions"));
  const mediaData = useRegistryResource<ProjectMedia[]>(`${projectPath}/media`,token,projectActive && section === "manage" && ["manage","media"].includes(projectTab));
  const memberData = useRegistryResource<ProjectMember[]>(`${projectPath}/members`,token,projectActive && section === "manage" && projectTab === "members");
  useEffect(()=>setReleases(releaseData.data ?? []),[releaseData.data,selectedProject]);
  useEffect(()=>setMedia(mediaData.data ?? []),[mediaData.data,selectedProject]);
  useEffect(()=>setMembers(memberData.data ?? []),[memberData.data,selectedProject]);
  useEffect(()=>{ const failure=releaseData.error||mediaData.error||memberData.error;if(failure)setError(failure); },[releaseData.error,mediaData.error,memberData.error]);

  const login = async () => {
    const attempt = ++loginAttempt.current;
    setError("");
    setStatus("Запрашиваем код GitHub…");
    try {
      const session = await invoke<DeviceSession>("registry_device_start");
      let interval = session.interval;
      setCodeCopied(false);
      setDeviceCode(session.user_code);
      const opened = await openUrl(session.verification_uri)
        .then(() => true)
        .catch(() => false);
      setStatus(
        opened
          ? "Ожидаем подтверждение в GitHub…"
          : "Откройте GitHub по ссылке ниже и введите код",
      );
      const deadline = Date.now() + session.expires_in * 1000;
      while (
        alive.current &&
        attempt === loginAttempt.current &&
        Date.now() < deadline
      ) {
        await delay(interval * 1000);
        if (!alive.current || attempt !== loginAttempt.current) return;
        const result = await invoke<{
          status: string;
          interval?: number;
          access_token?: string;
        }>("registry_device_poll", { requestId: session.request_id });
        interval = result.interval ?? interval;
        if (result.status === "complete" && result.access_token) {
          setToken(result.access_token);
          setDeviceCode("");
          try {
            await invoke("save_access_token", { token: result.access_token });
            setStatus("");
          } catch {
            setStatus(
              "Вход выполнен только до закрытия VLauncher: системное хранилище паролей недоступно",
            );
          }
          return;
        }
      }
      if (alive.current && attempt === loginAttempt.current)
        throw new Error("Срок действия кода GitHub истёк");
    } catch (reason) {
      setError(String(reason));
      setStatus("");
    }
  };
  const copyDeviceCode = async () => {
    if (!deviceCode) return;
    try {
      await writeText(deviceCode);
      setCodeCopied(true);
      window.setTimeout(() => {
        if (alive.current) setCodeCopied(false);
      }, 1800);
    } catch (reason) {
      setError(`Не удалось скопировать код: ${String(reason)}`);
    }
  };
  const createProject = async () => {
    if (!token) return;
    setError("");
    try {
      const created = await createCreatorProject(token, {
        type: draft.type,
        title: draft.title,
        summary: draft.summary,
        description: draft.description,
        license: draft.license,
        categories: draft.categories,
      });
      setSelectedProject(created.slug);
      setDraft(emptyProjectDraft);
      await refresh(token);
      setPrepared(null);
      setSection("release");
    } catch (reason) {
      setError(String(reason));
    }
  };
  const saveProject = async () => {
    if (!token) return;
    const current = projects.find((item) => item.slug === selectedProject);
    if (!current) return;
    try {
      await updateCreatorProject(token, current.slug, {
        title: current.title,
        summary: current.summary,
        description: current.description,
        license: current.license,
        categories: current.categories ?? [],
      });
      setStatus("Карточка проекта сохранена");
      await refresh(token);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const updateSelected = (change: Partial<CreatorProject>) =>
    setProjects((items) =>
      items.map((item) =>
        item.slug === selectedProject ? { ...item, ...change } : item,
      ),
    );
  const hasUnsavedProject = projects.some(
    (project) =>
      savedProjects.current.get(project.slug) !== JSON.stringify(project),
  );
  useEffect(()=>{
    if(!active||!token||hasUnsavedProject)return;
    const check=()=>{if(Date.now()-lastRefresh.current>60_000)void refresh(token).catch(e=>setError(String(e)));};
    check();window.addEventListener('focus',check);return()=>window.removeEventListener('focus',check);
  },[active,token,hasUnsavedProject,refresh]);

  const switchProject = (slug: string) => {
    setProjects((items) =>
      items.map((item) => {
        const saved = savedProjects.current.get(item.slug);
        return saved ? (JSON.parse(saved) as CreatorProject) : item;
      }),
    );
    setSelectedProject(slug);
    setPrepared(null);
    setPreparedSource(null);
    setStatus("");
  };
  const selectProject = (slug: string) => {
    if (slug !== selectedProject && hasUnsavedProject) {
      setPendingProject(slug);
      return;
    }
    if (slug !== selectedProject) switchProject(slug);
  };

  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedProject) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [hasUnsavedProject]);
  const preview = async () => {
    setError("");
    setPrepared(null);
    setPreparedSource(null);
    try {
      setPrepared(
        await invoke<PreparedArtifact>("prepare_release", { path: folder }),
      );
    } catch (reason) {
      setError(String(reason));
    }
  };
  const loadGithubReleases = async (page = 1) => {
    setError("");
    setGithubTask("releases");
    try {
      const result = await invoke<GithubReleasePage>("list_github_releases", {
        repository: githubRepository,
        page,
      });
      setGithubRepository(result.repository);
      setGithubReleases((items) => page === 1
        ? result.releases
        : [...items, ...result.releases.filter((release) =>
            !items.some((item) => item.id === release.id))]);
      setGithubPage(page);
      setGithubHasMore(result.has_more);
    } finally {
      setGithubTask("");
    }
  };
  const prepareGithubRelease = async (
    release: GithubRelease,
    archive: { assetId?: number; name: string; size?: number },
  ) => {
    setError("");
    setPrepared(null);
    setPreparedSource(null);
    setGithubTask("archive");
    setStatus(`Скачиваем ${archive.name} из GitHub…`);
    if (archive.size) {
      setTransfer({ completed: 0, total: archive.size, bytes_per_second: 0, eta_seconds: 0 });
    }
    try {
      const artifact = await invoke<PreparedArtifact>("prepare_github_release", {
        repository: githubRepository,
        assetId: archive.assetId ?? null,
        tag: archive.assetId ? null : release.tag_name,
      });
      setPrepared(artifact);
      setPreparedSource({
        repository: githubRepository,
        release: release.tag_name,
        archive: archive.name,
      });
      if (!changelog.trim() && release.body.trim()) setChangelog(release.body.trim());
      setStatus("ZIP из GitHub скачан и проверен");
    } catch (reason) {
      setStatus("");
      throw reason;
    } finally {
      setTransfer(null);
      setGithubTask("");
    }
  };
  const publish = async () => {
    const project = projects.find((item) => item.slug === selectedProject);
    const identityMatches = project?.type !== "mod" || !project.package_id ||
      prepared?.manifest.id === project.package_id;
    if (!token || !project || !prepared || !identityMatches) return;
    setError("");
    setStatus("Загружаем проверенный архив…");
    setTransfer({ completed: 0, total: prepared.size, bytes_per_second: 0, eta_seconds: 0 });
    try {
      const receipt = await invoke<{ id: string }>("publish_release", {
        token,
        projectId: project.id,
        artifact: prepared,
        channel,
        changelog,
      });
      const deadline = Date.now() + 120_000;
      for (;;) {
        if (!alive.current) return;
        if (Date.now() > deadline) {
          setStatus(
            "Архив загружен. Проверка продолжается на сервере - результат появится в списке версий.",
          );
          break;
        }
        const upload = await loadUpload(token, receipt.id);
        setStatus(
          upload.status === "processing"
            ? "Проверяем архив…"
            : "Релиз обрабатывается…",
        );
        if (upload.status === "published") {
          invalidateRegistry(token);
          setStatus("Версия опубликована автоматически");
          break;
        }
        if (upload.status === "awaiting_moderation") {
          setStatus("Релиз проверен и ожидает модерации");
          break;
        }
        if (upload.status === "rejected")
          throw new Error(upload.error ?? "Архив отклонён");
        await delay(1000);
      }
      invalidateRegistry(token);
      await refresh(token);
      setReleases(await loadCreatorReleases(token, selectedProject));
      setTransfer(null);
    } catch (reason) {
      setError(friendlyError(reason));
      setStatus("");
    } finally {
      setTransfer(null);
    }
  };
  const createOrg = async () => {
    if (!token) return;
    try {
      await createOrganization(token, organizationDraft);
      setOrganizationDraft({ slug: "", name: "", description: "" });
      await refresh(token);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const chooseOrg = async (organization: string) => {
    if (!token || !selectedProject) return;
    try {
      await assignOrganization(token, selectedProject, organization || null);
      await refresh(token);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const addMember = async () => {
    if (!token || !selectedProject || !member) return;
    try {
      await setProjectMember(token, selectedProject, member, memberRole);
      setMember("");
      setMembers(await loadProjectMembers(token, selectedProject));
      setStatus("Участник добавлен");
    } catch (reason) {
      setError(String(reason));
    }
  };
  const removeMember = async (username: string) => {
    if (!token || !selectedProject) return;
    try {
      await removeProjectMember(token, selectedProject, username);
      setMembers(await loadProjectMembers(token, selectedProject));
    } catch (reason) {
      setError(String(reason));
    }
  };
  const [editingImage, setEditingImage] = useState<{
    kind: "cover" | "gallery";
    file: File;
  } | null>(null);
  const addMedia = (kind: "cover" | "gallery", file?: File) => {
    if (file) setEditingImage({ kind, file });
  };
  const refreshProjectImages = async () => {
    const updated = await loadCreatorProjects(token);
    const metadata = new Map(updated.map((project) => [project.slug, {
      status: project.status,
      cover_url: project.cover_url,
      preview_url: project.preview_url,
    }]));
    for (const [slug, fields] of metadata) {
      const saved = savedProjects.current.get(slug);
      if (saved) savedProjects.current.set(slug, JSON.stringify({ ...JSON.parse(saved), ...fields }));
    }
    setProjects((items) => items.map((item) => ({ ...item, ...metadata.get(item.slug) })));
  };
  const saveMedia = async (
    kind: "cover" | "gallery" | "description",
    file: File,
  ) => {
    if (!token || !selectedProject) throw new Error("Сначала создайте проект");
    {
      const saved = await uploadProjectMedia(
        token,
        selectedProject,
        kind,
        file,
      );
      setMedia(await loadProjectMedia(token, selectedProject));
      setStatus(
        "Изображение сохранено.",
      );
      await refreshProjectImages();
      return saved;
    }
  };
  const removeMedia = async (item: ProjectMedia) => {
    if (!token || !selectedProject || working) throw new Error("Действие сейчас недоступно");
    setWorking(true);
    try {
      await deleteProjectMedia(token, selectedProject, item.id);
      setMedia(await loadProjectMedia(token, selectedProject));
      await refreshProjectImages();
      setStatus("Изображение удалено.");
    } finally {
      setWorking(false);
    }
  };
  const lifecycle = async (
    release: CreatorRelease,
    action: "yank" | "deprecate",
    message = "",
  ) => {
    if (!token) return;
    try {
      if (action === "yank")
        await yankRelease(token, selectedProject, release.version);
      else
        await deprecateRelease(
          token,
          selectedProject,
          release.version,
          message,
        );
      setReleases(await loadCreatorReleases(token, selectedProject));
    } catch (reason) {
      setError(String(reason));
    }
  };
  const confirmLifecycle = (
    release: CreatorRelease,
    action: "yank" | "deprecate",
  ) => {
    setLifecycleReason(release.deprecation_message ?? "");
    setLifecycleDialog({ release, action });
  };

  if (!tokenReady || token && !account) return <><div className="page-title"><h1>Мастерская</h1></div>{error ? <ErrorNotice retry={()=>void refresh(token).catch(e=>setError(String(e)))}>{error}</ErrorNotice> : <p role="status">Загружаем мастерскую…</p>}</>;
  if (!token || !account)
    return (
      <>
        <div className="page-title">
          <div>
            <h1>Мастерская</h1>
          </div>
        </div>
        <section className="creator-login">
          <h2>Войдите через GitHub</h2>
          <p>
            Публикуйте контент-паки, сборки и карты в каталоге VLauncher. Для игры и
            установки контента вход не нужен.
          </p>
          {deviceCode && (
            <div className="creator-device-login" role="status">
              <p>
                Откройте{" "}
                <button
                  className="dependency-project-link"
                  onClick={() =>
                    void openUrl("https://github.com/login/device").catch(
                      (reason) => setError(String(reason)),
                    )
                  }
                >
                  github.com/login/device
                </button>{" "}
                и введите код:
              </p>
              <button
                className={`device-code ${codeCopied ? "copied" : ""}`}
                aria-label={`Скопировать код ${deviceCode}`}
                onClick={() => void copyDeviceCode()}
              >
                <strong>{deviceCode}</strong>
                <span>{codeCopied ? "Скопировано" : "Копировать"}</span>
              </button>
            </div>
          )}
          <div className="creator-login-actions">
            <button
              className="primary"
              disabled={working}
              onClick={() => void perform(login)}
            >
              {status || "Войти через GitHub"}
            </button>
            {working && (
              <button
                onClick={() => {
                  loginAttempt.current++;
                  setWorking(false);
                  setStatus("");
                  setDeviceCode("");
                  setCodeCopied(false);
                }}
              >
                Отмена
              </button>
            )}
          </div>
          {error && (
            <div className="notice error compact" role="alert">
              <div>
                {error.includes("secure storage")
                  ? "Не удалось открыть системное хранилище паролей. Сохранённый вход сейчас недоступен."
                  : "Не удалось войти в аккаунт."}
                <details>
                  <summary>Подробности</summary>
                  {error}
                </details>
              </div>
            </div>
          )}
          {token && !account && (
            <button
              disabled={working}
              onClick={() => void perform(async () => { invalidateRegistry(token); await refresh(token); })}
            >
              Повторить загрузку аккаунта
            </button>
          )}
        </section>
      </>
    );
  const current = projects.find((item) => item.slug === selectedProject);
  const currentImage = creatorProjectImage(current);
  const modpackProfiles = localProfiles.filter(
    (profile) => !profileModpack(profile) || profileModpack(profile)?.id === current?.id,
  );
  const selectedModpackProfile = modpackProfiles.find((profile) => profile.id === modpackProfile);
  const draftKind = projectKindInfo(draft.type);
  const currentKind = current ? projectKindInfo(current.type) : null;
  const preparedKind = prepared?.manifest.type === "library"
    ? "mod"
    : prepared?.manifest.type;
  const preparedMatchesProject = !!prepared && !!current &&
    preparedKind === current.type &&
    (current.type !== "mod" || !current.package_id || prepared.manifest.id === current.package_id);
  return (
    <>
      {editingImage && (
        <ImageEditor
          file={editingImage.file}
          cover={editingImage.kind === "cover"}
          close={() => setEditingImage(null)}
          onSave={async (file) => {
            await saveMedia(editingImage.kind, file);
          }}
        />
      )}
      <div className="page-title">
        <div>
          <p className="eyebrow supporting-label">Мастерская · @{account.username}</p>
          <h1>Мастерская</h1>
        </div>
        <button
          className="secondary"
          disabled={working}
          onClick={() =>
            void perform(async () => {
              await revokeSession(token).catch(() => undefined);
              await invoke("delete_access_token").catch(() => undefined);
              clearPrivateCache(token);
              setToken("");
              setAccount(null);
            })
          }
        >
          Выйти
        </button>
      </div>
      <div className="workshop-refresh">
        <button
          disabled={working}
          onClick={() => void perform(async () => { invalidateRegistry(token); await refresh(token); })}
        >
          Обновить данные
        </button>
      </div>
      {error && <div className="notice error compact">{error}</div>}
      {status && <div className="notice success compact">{status}</div>}
      <nav className="workshop-nav" aria-label="Разделы мастерской">
        {[
          ["projects", "Мои проекты"],
          ["team", "Команды"],
          ["sessions", "Аккаунт"],
          ...(["owner", "admin", "moderator"].includes(account.role)
            ? [["moderation", "Управление платформой"]]
            : []),
        ].map(([id, label]) => (
          <button
            key={id}
            className={
              section === id ||
              (id === "projects" &&
                ["create", "manage", "release"].includes(section))
                ? "active"
                : ""
            }
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {section === "sessions" && <FeedbackPanel request={<T,>(path: string, init?: RequestInit) => registryRequest<T>(path, init, token)} />}
      {section === "projects" && (
        <section className="workshop-projects">
          <div className="section-heading">
            <div>
              <h2>Мои проекты · {projects.length}</h2>
              <p>Ваши публикации и совместные работы.</p>
            </div>
            <button className="primary" onClick={() => setSection("create")}>
              Создать проект
            </button>
          </div>
          <div className="workshop-stats">
            <div>
              <strong>
                {projects
                  .reduce((sum, p) => sum + (p.downloads ?? 0), 0)
                  .toLocaleString("ru")}
              </strong>
              <span>Загрузок за всё время</span>
            </div>
            <div>
              <strong>
                {projects.filter((p) => p.status === "published").length}
              </strong>
              <span>Опубликовано</span>
            </div>
            <div>
              <strong>
                {projects.filter((p) => p.status !== "published").length}
              </strong>
              <span>В работе</span>
            </div>
          </div>
          <div className="form-row" aria-label="Список проектов">
            <button aria-pressed={!showArchived} onClick={() => setShowArchived(false)}>Основные · {projects.filter(p => !p.archived_at).length}</button>
            <button aria-pressed={showArchived} onClick={() => setShowArchived(true)}>Архив · {projects.filter(p => !!p.archived_at).length}</button>
          </div>
          {!!projects.length && (
            <label>
              Поиск моих проектов
              <input
                className="workshop-search"
                aria-label="Поиск моих проектов"
                placeholder="Найти свой проект…"
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
              />
            </label>
          )}
          <div className="workshop-project-list">
            {projects.filter(p => !!p.archived_at === showArchived)
              .filter((p) =>
                (p.title + p.slug)
                  .toLowerCase()
                  .includes(projectSearch.toLowerCase()),
              )
              .map((project) => (
                <button
                  className="workshop-project"
                  key={project.id}
                  onClick={() => {
                    selectProject(project.slug);
                    setProjectTab("manage");
                    setSection("manage");
                  }}
                >
                  <span className="workshop-project-avatar">
                    {creatorProjectImage(project) ? (
                      <PrivateImage
                        src={creatorProjectImage(project)!}
                        alt=""
                        token={registryMediaUrl(creatorProjectImage(project)!, registryUrl) ? token : ""}
                        fallback={project.title.slice(0, 1).toUpperCase()}
                      />
                    ) : project.title.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="workshop-project-copy">
                    <strong>{project.title}</strong>
                    <span>
                      {project.summary || "Описание пока не добавлено"}
                    </span>
                    <small>
                      {projectKind(project.type)}
                    </small>
                  </span>
                  <span className="workshop-project-meta">
                    <span className={"publication-status " + project.status}>
                      {publicationStatus(project.status)}{project.archived_at ? " · В архиве" : ""}
                    </span>
                    <small>
                      {(project.downloads ?? 0).toLocaleString("ru")} загрузок
                    </small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              ))}
          </div>
          {!projects.length && (
            <div className="workshop-empty">
              <h3>Здесь начнётся ваш первый проект</h3>
              <p>
                Оформите карточку, добавьте изображения и загрузите первую
                версию.
              </p>
              <button onClick={() => setSection("create")}>
                Создать первый проект
              </button>
            </div>
          )}
          {!!projects.length &&
            !projects.some((p) =>
              !!p.archived_at === showArchived && (p.title + p.slug)
                .toLowerCase()
                .includes(projectSearch.toLowerCase()),
            ) && (
              <p className="workshop-empty">{projectSearch ? "Проектов по этому запросу нет." : showArchived ? "Архив пуст." : "Все проекты находятся в архиве."}</p>
            )}
        </section>
      )}
      {["manage", "release"].includes(section) && current && (
        <header className="workshop-project-header">
          <button
            className="text-button"
            onClick={() => setSection("projects")}
          >
            ‹ Все проекты
          </button>
          <div className="section-heading">
            <div className="workshop-project-identity">
              <span className={`workshop-kind-mark ${current.type}`}>
                {currentImage ? (
                  <PrivateImage
                    src={currentImage}
                    alt=""
                    token={registryMediaUrl(currentImage, registryUrl) ? token : ""}
                    fallback={current.title.slice(0, 1).toUpperCase()}
                  />
                ) : (
                  <Icon name={currentKind!.icon} size={24} />
                )}
              </span>
              <div>
                <p className="eyebrow supporting-label">
                  {currentKind!.name}
                </p>
                <h2>{current.title}</h2>
                {current.summary && <p className="workshop-project-summary">{current.summary}</p>}
              </div>
            </div>
            <div className="form-row">
            <span className={"publication-status " + current.status}>
              {publicationStatus(current.status)}{current.archived_at ? " · В архиве" : ""}
            </span>
            </div>
          </div>
          <nav className="workshop-project-tabs" aria-label="Разделы проекта">
            {[
              ["manage", "Описание"],
              ["media", "Обложка и скриншоты"],
              ["versions", "Версии"],
              ["analytics", "Статистика"],
              ["members", "Участники"],
              ["settings", "Настройки проекта"],
            ].map(([id, name]) => (
              <button
                key={id}
                className={
                  section === "manage" && projectTab === id ? "active" : ""
                }
                onClick={() => {
                  setSection("manage");
                  setProjectTab(id);
                }}
              >
                {name}
              </button>
            ))}
            {current.type !== "runtime" && (
              <button
                className={section === "release" ? "active" : ""}
                onClick={() => setSection("release")}
              >
                + Новая версия
              </button>
            )}
          </nav>
        </header>
      )}
      <fieldset disabled={working} className="creator-fieldset">
        <div className="creator-grid">
          <section
            hidden={section !== "create"}
            className="form-card new-project-form"
          >
            <button
              className="text-button"
              onClick={() => setSection("projects")}
            >
              ‹ Мои проекты
            </button>
            <div className={`creator-kind-heading ${draft.type}`}>
              <span className="workshop-kind-mark">
                <Icon name={draftKind.icon} size={28} />
              </span>
              <div>
                <span className="supporting-label">Новый проект</span>
                <h2>{draftKind.newTitle}</h2>
                <p>{draftKind.description}</p>
              </div>
            </div>
            <fieldset className="creator-kind-picker">
              <legend>Что вы создаёте?</legend>
              <p>Тип определяет раздел каталога и способ подготовки версий.</p>
              <div>
                {(["mod", "modpack", "world"] as const).map((kind) => {
                  const info = projectKindInfo(kind);
                  return (
                    <button
                      type="button"
                      key={kind}
                      className={draft.type === kind ? "active" : ""}
                      aria-pressed={draft.type === kind}
                      onClick={() =>
                        setDraft({ ...draft, type: kind, categories: [] })
                      }
                    >
                      <span className={`workshop-kind-mark ${kind}`}>
                        <Icon name={info.icon} size={22} />
                      </span>
                      <span>
                        <strong>{info.name}</strong>
                        <small>{info.choiceDescription}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>
            <label>
              {draftKind.titleLabel}
              <input
                aria-label="Название проекта"
                placeholder={draftKind.titlePlaceholder}
                value={draft.title}
                onChange={(event) =>
                  setDraft({ ...draft, title: event.target.value })
                }
              />
            </label>
            <label>
              {draftKind.summaryLabel}
              <input
                aria-label="Краткое описание проекта"
                placeholder={draftKind.summaryPlaceholder}
                value={draft.summary}
                onChange={(event) =>
                  setDraft({ ...draft, summary: event.target.value })
                }
              />
            </label>
            <MarkdownEditor
              label={draftKind.descriptionLabel}
              value={draft.description}
              onChange={(description) => setDraft({ ...draft, description })}
              token={token}
            />
            <label>
              Лицензия · необязательно
              <input
                maxLength={128}
                value={draft.license}
                placeholder="Например, MIT, CC BY 4.0 или название своей лицензии"
                onChange={(event) =>
                  setDraft({ ...draft, license: event.target.value })
                }
              />
              <small>
                Укажите условия автора. Для собственной лицензии добавьте текст
                или ссылку в описание.
              </small>
            </label>
            <CategoryPicker
              kind={draft.type}
              value={draft.categories}
              onChange={(categories) => setDraft({ ...draft, categories })}
            />
            <button
              className="primary small"
              disabled={
                !draft.title.trim() ||
                !draft.summary.trim()
              }
              onClick={() => void perform(createProject)}
            >
              {draftKind.createLabel}
            </button>
          </section>
          <section hidden={section !== "release"} className={`form-card release-composer ${current?.type || ""}`}>
            <div className="release-composer-heading">
              <div>
                <h2>Новая версия</h2>
                <p>{current?.type === "mod"
                  ? "Загрузите исходную папку или готовый ZIP контент-пака."
                  : current?.type === "modpack"
                    ? "Зафиксируйте текущее состояние игрового профиля как новую версию сборки."
                    : current?.type === "world"
                      ? "Выберите установленный профиль и мир, который нужно опубликовать."
                      : "Сначала выберите проект для публикации."}</p>
              </div>
            </div>
            {!current && (
              <label>
                Проект
                <Select
                  aria-label="Проект для релиза"
                  value={selectedProject}
                  onChange={(event) => selectProject(event.target.value)}
                >
                  <option value="">Выберите проект</option>
                  {projects.filter((project) => project.type !== "runtime").map((project) => (
                    <option value={project.slug} key={project.id}>
                      {project.title} · {projectKindInfo(project.type).name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            {current?.type === "mod" && (
              <section className="release-source-card">
                <div>
                  <strong>Файлы контент-пака</strong>
                  <span>Версия и совместимость будут прочитаны из package.json.</span>
                </div>
                <div className="form-row release-source-tabs" role="group" aria-label="Источник файлов">
                  <button
                    type="button"
                    aria-pressed={releaseSource === "local"}
                    onClick={() => { setReleaseSource("local"); setPrepared(null); setPreparedSource(null); setStatus(""); }}
                  >
                    Локальные файлы
                  </button>
                  <button
                    type="button"
                    aria-pressed={releaseSource === "github"}
                    onClick={() => { setReleaseSource("github"); setPrepared(null); setPreparedSource(null); setStatus(""); }}
                  >
                    GitHub
                  </button>
                </div>
                {releaseSource === "local" ? (
                  <>
                    <label>
                      Папка или ZIP-архив
                      <input
                        aria-label="Папка или ZIP-архив"
                        placeholder="Путь к папке проекта или .zip"
                        value={folder}
                        disabled={working}
                        onChange={(event) => { setFolder(event.target.value); setPrepared(null); setPreparedSource(null); }}
                      />
                    </label>
                    <div className="form-row">
                      <button className="secondary" disabled={working} onClick={() => void perform(async () => {
                        const path = await open({ directory: true, multiple: false });
                        if (path) { setFolder(path); setPrepared(null); setPreparedSource(null); setStatus(""); }
                      })}>Выбрать папку</button>
                      <button className="secondary" disabled={working} onClick={() => void perform(async () => {
                        const path = await open({ directory: false, multiple: false, filters: [{ name: "ZIP-архив", extensions: ["zip"] }] });
                        if (path) { setFolder(path); setPrepared(null); setPreparedSource(null); setStatus(""); }
                      })}>Выбрать ZIP</button>
                      <button className="primary" disabled={working || !folder.trim()} onClick={() => void perform(preview)}>Проверить пакет</button>
                    </div>
                  </>
                ) : (
                  <div className="github-release-source">
                    <label>
                      Публичный репозиторий GitHub
                      <input
                        aria-label="Публичный репозиторий GitHub"
                        placeholder="owner/repository или ссылка"
                        value={githubRepository}
                        onChange={(event) => {
                          setGithubRepository(event.target.value);
                          setGithubReleases([]);
                          setGithubPage(0);
                          setGithubHasMore(false);
                          setPrepared(null);
                          setPreparedSource(null);
                        }}
                      />
                    </label>
                    <button
                      className="secondary small github-load-releases"
                      disabled={working || !githubRepository.trim()}
                      onClick={() => void perform(() => loadGithubReleases())}
                    >
                      {githubTask === "releases" ? "Загружаем…" : "Найти релизы"}
                    </button>
                    {!!githubReleases.length && (
                      <div className="github-release-list" aria-label="Релизы GitHub">
                        {githubReleases.map((release) => (
                          <article className="github-release-card" key={release.id}>
                            <header>
                              <div>
                                <strong>{release.name}</strong>
                                <span>
                                  {release.tag_name} · {new Date(release.published_at).toLocaleDateString("ru")}
                                </span>
                              </div>
                              <span className="publication-status published">
                                {release.prerelease ? "Предрелиз" : "Стабильный"}
                              </span>
                            </header>
                            <div className="github-release-assets">
                              {release.assets.map((asset) => (
                                <div className="github-release-asset" key={asset.id}>
                                  <span>
                                    <strong>{asset.name}</strong>
                                    <small>{formatBytes(asset.size)}</small>
                                  </span>
                                  <button
                                    className="secondary small"
                                    disabled={working}
                                    onClick={() => void perform(() => prepareGithubRelease(release, {
                                      assetId: asset.id,
                                      name: asset.name,
                                      size: asset.size,
                                    }))}
                                  >
                                    Скачать и проверить
                                  </button>
                                </div>
                              ))}
                              <div className="github-release-asset source-archive">
                                <span>
                                  <strong>Исходный код · ZIP</strong>
                                  <small>Автоматический архив GitHub для тега {release.tag_name}</small>
                                </span>
                                <button
                                  className="secondary small"
                                  disabled={working}
                                  onClick={() => void perform(() => prepareGithubRelease(release, {
                                    name: `Исходный код ${release.tag_name}.zip`,
                                  }))}
                                >
                                  Скачать и проверить
                                </button>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                    {!working && githubReleases.length === 0 && (
                      <p className="muted">
                        {githubPage > 0
                          ? "В репозитории нет опубликованных релизов."
                          : "Укажите репозиторий и загрузите список публичных релизов."}
                      </p>
                    )}
                    {githubHasMore && (
                      <button
                        className="text-button github-more-releases"
                        disabled={working}
                        onClick={() => void perform(() => loadGithubReleases(githubPage + 1))}
                      >
                        Показать ещё
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}
            {current?.type === "modpack" && (
              <section className="release-source-card">
                <div>
                  <strong>Профиль сборки</strong>
                  <span>VoxelCore, версии контента и настройки config будут зафиксированы автоматически.</span>
                </div>
                <div className="release-source-fields">
                  <label>
                    Профиль
                    <Select aria-label="Профиль для сборки" value={selectedModpackProfile?.id || ""} onChange={(event) => { setModpackProfile(event.target.value); setSelectedModpackWorlds([]); setPrepared(null); }}>
                      <option value="" disabled>Выберите профиль</option>
                      {modpackProfiles.map((profile) => (
                        <option value={profile.id} key={profile.id}>{profile.name}</option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    Версия сборки
                    <input aria-label="Версия новой сборки" value={modpackVersion} onChange={(event) => { setModpackVersion(event.target.value); setPrepared(null); }} />
                  </label>
                </div>
                <div className="modpack-world-selection">
                  <div>
                    <strong>Стартовые карты</strong>
                    <span>Будут загружены отдельными артефактами и скопированы в новый профиль один раз.</span>
                  </div>
                  {modpackWorldsLoading ? (
                    <span className="muted">Загружаем миры…</span>
                  ) : modpackWorlds.length ? (
                    <div className="modpack-world-list">
                      {modpackWorlds.map((world) => (
                        <label className="checkbox-row" key={world.folder}>
                          <input
                            type="checkbox"
                            checked={selectedModpackWorlds.includes(world.folder)}
                            onChange={(event) => {
                              setSelectedModpackWorlds((selected) => event.target.checked
                                ? [...selected, world.folder]
                                : selected.filter((folder) => folder !== world.folder));
                              setPrepared(null);
                            }}
                          />
                          <span><strong>{world.name}</strong><small>{world.folder}</small></span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <span className="muted">В профиле нет карт.</span>
                  )}
                </div>
                <button className="primary small" disabled={working || !selectedModpackProfile || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(modpackVersion)} onClick={() => void perform(async () => {
                  if (!account) return;
                  setPrepared(await invoke<PreparedArtifact>("prepare_profile_modpack", {
                    profileId: modpackProfile, slug: current.slug, title: current.title,
                    version: modpackVersion, creator: account.username, license: current.license || "",
                    worlds: selectedModpackWorlds,
                  }));
                })}>Подготовить сборку</button>
              </section>
            )}
            {current?.type === "world" && (
              <section className="release-source-card">
                <div>
                  <strong>Мир из профиля</strong>
                  <span>Личные данные игрока и временные файлы не попадут в публикацию.</span>
                </div>
                <div className="release-source-fields">
                  <label>
                    Профиль
                    <Select aria-label="Профиль с картой" value={worldProfile} onChange={(event) => { setWorldProfile(event.target.value); setPrepared(null); }}>
                      <option value="" disabled>Выберите профиль</option>
                      {localProfiles.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}
                    </Select>
                  </label>
                  <label>
                    Мир
                    <Select aria-label="Мир для публикации" value={worldFolder} disabled={!worldProfile || worldsLoading || !worlds.length} onChange={(event) => { setWorldFolder(event.target.value); setPrepared(null); }}>
                      <option value="" disabled>{worldsLoading ? "Загружаем миры…" : worlds.length ? "Выберите мир" : "В профиле нет миров"}</option>
                      {worlds.map((world) => <option value={world.folder} key={world.folder}>{world.name}</option>)}
                    </Select>
                  </label>
                  <label>
                    Версия карты
                    <input aria-label="Версия карты" value={worldVersion} onChange={(event) => { setWorldVersion(event.target.value); setPrepared(null); }} />
                  </label>
                </div>
                <button className="primary small" disabled={working || !worldProfile || !worldFolder || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(worldVersion)} onClick={() => void perform(async () => {
                  if (!account) return;
                  setPrepared(await invoke<PreparedArtifact>("prepare_profile_world", {
                    profileId: worldProfile, folder: worldFolder, slug: current.slug,
                    title: current.title, version: worldVersion, creator: account.username,
                    license: current.license || "",
                  }));
                })}>Подготовить карту</button>
              </section>
            )}
            {current && (
              <div className="release-metadata-fields">
                <label>
                  Канал релиза
                  <Select aria-label="Канал релиза" value={channel} onChange={(event) => setChannel(event.target.value)}>
                    <option value="stable">Стабильная</option>
                    <option value="beta">Бета</option>
                    <option value="alpha">Альфа</option>
                  </Select>
                </label>
                <label>
                  Список изменений
                  <textarea aria-label="Список изменений" placeholder="Что изменилось в этой версии" value={changelog} onChange={(event) => setChangelog(event.target.value)} />
                </label>
              </div>
            )}
            {prepared && (
              <div className="package-preview release-ready-card">
                <span className="supporting-label">Подготовлено к загрузке</span>
                <strong>
                  {prepared.manifest.title} {prepared.manifest.version}
                </strong>
                <ManifestContentLinks
                  manifest={prepared.manifest}
                  parent={prepared.manifest.title}
                  compact={prepared.manifest.type === "modpack"}
                />
                <span>
                  {(prepared.size / 1024 / 1024).toFixed(2)} MiB ·{" "}
                  {prepared.sha256.slice(0, 12)}…
                </span>
                {preparedSource && (
                  <span>
                    GitHub · {preparedSource.repository} · {preparedSource.release} · {preparedSource.archive}
                  </span>
                )}
                {!!prepared.manifest.components?.length && (
                  <span>Стартовые карты: {prepared.manifest.components.map((item) => item.title).join(", ")}</span>
                )}
                <span>
                  {prepared.manifest.capabilities?.length
                    ? `Разрешения: ${prepared.manifest.capabilities.join(", ")}`
                    : "Без дополнительных разрешений"}
                </span>
                {prepared.manifest.voxelcore === "*" && (
                  <span className="notice" role="note">
                    Ограничение версии VoxelCore не задано. Релиз будет доступен
                    для всех версий движка.
                  </span>
                )}
              </div>
            )}
            <p id="release-publish-state" role="status" className="release-publish-state">
              {working
                ? "Выполняется операция…"
                : !selectedProject
                  ? "Выберите проект, для которого публикуете версию."
                  : !prepared
                    ? current?.type === "mod"
                      ? "Выберите файлы контент-пака и проверьте пакет."
                      : current?.type === "modpack"
                        ? "Выберите профиль и подготовьте сборку."
                        : "Выберите профиль, мир и подготовьте карту."
                    : !preparedMatchesProject
                      ? "Подготовленные файлы не соответствуют выбранному проекту."
                      : `Версия ${prepared.manifest.version} готова к отправке.`}
            </p>
            {transfer && (
              <div className="transfer-progress">
                <progress max={transfer.total} value={transfer.completed} />
                <span>
                  {(transfer.completed / 1024 / 1024).toFixed(1)} из{" "}
                  {(transfer.total / 1024 / 1024).toFixed(1)} МБ ·{" "}
                  {(transfer.bytes_per_second / 1024 / 1024).toFixed(1)} МБ/с
                  {transfer.eta_seconds > 0
                    ? ` · около ${transfer.eta_seconds} с`
                    : ""}
                </span>
              </div>
            )}
            <button
              className="primary small"
              aria-describedby="release-publish-state"
              disabled={
                working || !preparedMatchesProject
              }
              onClick={() => void perform(publish)}
            >
              Отправить на проверку
            </button>
            {working && transfer && (
              <button
                className="secondary small"
                onClick={() => void invoke("cancel_transfer")}
              >
                Приостановить загрузку
              </button>
            )}
          </section>
          {current && (
            <section
              hidden={
                section !== "manage" ||
                ["versions", "analytics"].includes(projectTab)
              }
              className="form-card"
            >
              <div hidden={projectTab !== "manage"} className="workshop-fields">
                <h2>Описание проекта</h2>
                <div className="media-shortcut">
                  <div>
                    <strong>Обложка и скриншоты</strong>
                    <p>
                      {media.some((m) => m.kind === "cover")
                        ? "Обложка добавлена"
                        : "Добавьте обложку, чтобы проект узнавали в каталоге"}{" "}
                      · {media.filter((m) => m.kind === "gallery").length} из 8
                      скриншотов
                    </p>
                  </div>
                  <button type="button" onClick={() => setProjectTab("media")}>
                    Оформить изображения
                  </button>
                </div>
                <p>
                  Изменения опубликованной карточки отправляются на проверку. До
                  одобрения проект будет скрыт из каталога.
                </p>
                <label>
                  Название проекта
                  <input
                    aria-label="Название проекта"
                    value={current.title}
                    onChange={(event) =>
                      updateSelected({ title: event.target.value })
                    }
                  />
                </label>
                <label>
                  Краткое описание проекта
                  <input
                    aria-label="Краткое описание проекта"
                    value={current.summary}
                    onChange={(event) =>
                      updateSelected({ summary: event.target.value })
                    }
                  />
                </label>
                <MarkdownEditor
                  key={current.slug}
                  onUploadImage={async (file) =>
                    (await saveMedia("description", file)).url
                  }
                  label="Полное описание проекта"
                  value={current.description}
                  onChange={(description) => updateSelected({ description })}
                  token={token}
                />
                <label>
                  Лицензия проекта
                  <input
                    aria-label="Лицензия проекта"
                    maxLength={128}
                    placeholder="Не указана"
                    value={current.license ?? ""}
                    onChange={(event) =>
                      updateSelected({ license: event.target.value })
                    }
                  />
                </label>
                <CategoryPicker
                  kind={current.type}
                  value={current.categories ?? []}
                  onChange={(categories) => updateSelected({ categories })}
                />
                <button
                  className="primary small"
                  onClick={() => void perform(saveProject)}
                >
                  Сохранить описание
                </button>
              </div>
              {projectTab === "settings" && (
                <ProjectLifecycleActions key={current.slug} project={current} disabled={working}
                  request={(path, init) => registryRequest(path, init, token)}
                  changed={(action) => {
                    if (action === "delete") {
                      setProjects(items => items.filter(item => item.slug !== current.slug));
                      savedProjects.current.delete(current.slug);
                      setSelectedProject(""); setPrepared(null); setSection("projects");
                      setStatus("Проект удалён. Очистка файлов выполняется на сервере.");
                    } else {
                      const archived_at = action === "archive" ? new Date().toISOString() : null;
                      const saved = savedProjects.current.get(current.slug);
                      if (saved) savedProjects.current.set(current.slug, JSON.stringify({ ...JSON.parse(saved), archived_at }));
                      setProjects(items => items.map(item => item.slug === current.slug ? { ...item, archived_at } : item));
                      setShowArchived(action === "archive");
                      setStatus(action === "archive" ? "Проект перемещён в архив." : "Проект возвращён из архива.");
                    }
                  }} />
              )}
              {projectTab === "media" && (
                <ProjectMediaEditor
                  media={media}
                  token={token}
                  loading={mediaData.loading}
                  error={mediaData.error}
                  retry={mediaData.refresh}
                  busy={working}
                  add={addMedia}
                  remove={removeMedia}
                  insert={(item) => {
                    updateSelected({ description: current.description + "\n\n![" + (item.kind === "cover" ? "Обложка" : "Скриншот") + "](" + item.url + ")" });
                    setProjectTab("manage");
                    setStatus("Изображение вставлено. Сохраните описание, чтобы опубликовать изменение.");
                  }}
                />
              )}
              <div
                hidden={projectTab !== "members"}
                className="workshop-fields"
              >
                <h2>Участники проекта</h2>
                <p>Управляйте доступом к публикации версий.</p>
                <Select
                  aria-label="Организация проекта"
                  value={current.organization ?? ""}
                  onChange={(event) =>
                    void perform(() => chooseOrg(event.target.value))
                  }
                >
                  <option value="">Личный проект</option>
                  {organizations.map((organization) => (
                    <option value={organization.slug} key={organization.id}>
                      {organization.name}
                    </option>
                  ))}
                </Select>
                <div className="form-row">
                  <label>
                    GitHub username участника
                    <input
                      aria-label="GitHub username участника"
                      placeholder="GitHub username участника"
                      value={member}
                      onChange={(event) => setMember(event.target.value)}
                    />
                  </label>
                  <button
                    className="secondary"
                    onClick={() => void perform(addMember)}
                  >
                    Добавить
                  </button>
                </div>
                <Select
                  aria-label="Роль нового участника"
                  value={memberRole}
                  onChange={(event) =>
                    setMemberRole(event.target.value as "maintainer" | "member")
                  }
                >
                  <option value="maintainer">Может публиковать</option>
                  <option value="member">Участник без публикации</option>
                </Select>
                <div className="member-list">
                  {members.map((item) => (
                    <div key={item.username}>
                      <span>
                        <strong>@{item.username}</strong>
                        <small>{item.role}</small>
                      </span>
                      {item.role !== "owner" && (
                        <button
                          type="button"
                          onClick={() => void removeMember(item.username)}
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
          <section hidden={section !== "team"} className="form-card">
            <h2>Команды</h2>
            {organizations.map((org) => (
              <article className="review-card" key={org.id}>
                <h3>{org.name}</h3>
                <p>{org.description}</p>
                <small>
                  {org.slug} ·{" "}
                  {org.role === "owner"
                    ? "Владелец"
                    : org.role === "maintainer"
                      ? "Редактор"
                      : "Участник"}
                </small>
              <TeamActions slug={org.slug} request={<T,>(path: string, init?: RequestInit) => registryRequest<T>(path, init, token)} changed={() => void refresh(token).catch(e => setError(String(e)))} />
              </article>
            ))}
            <h3>Создать команду</h3>
            <p>
              Команда объединяет проекты и участников с общим доступом к
              публикации.
            </p>
            <label>
              Идентификатор организации
              <input
                aria-label="Идентификатор организации"
                placeholder="slug"
                value={organizationDraft.slug}
                onChange={(event) =>
                  setOrganizationDraft({
                    ...organizationDraft,
                    slug: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Название организации
              <input
                aria-label="Название организации"
                placeholder="Название"
                value={organizationDraft.name}
                onChange={(event) =>
                  setOrganizationDraft({
                    ...organizationDraft,
                    name: event.target.value,
                  })
                }
              />
            </label>
            <label>
              Описание организации
              <textarea
                aria-label="Описание организации"
                placeholder="Описание"
                value={organizationDraft.description}
                onChange={(event) =>
                  setOrganizationDraft({
                    ...organizationDraft,
                    description: event.target.value,
                  })
                }
              />
            </label>
            <button
              className="primary small"
              onClick={() => void perform(createOrg)}
            >
              Создать организацию
            </button>
          </section>
          <section hidden={section !== "sessions"} className="management-list">
            <h2>Активные входы</h2>
            {sessions
              .filter((session) => !session.revoked_at)
              .map((session) => (
                <article key={session.id}>
                  <div>
                    <strong>
                      {session.id === tokenSessionId(token)
                        ? "Этот VLauncher"
                        : "Другая сессия"}
                    </strong>
                    <span>
                      Создана{" "}
                      {new Date(session.created_at).toLocaleString("ru")} · до{" "}
                      {new Date(session.expires_at).toLocaleDateString("ru")}
                    </span>
                  </div>
                  {!session.revoked_at &&
                    session.id !== tokenSessionId(token) && (
                      <button
                        className="danger"
                        onClick={() =>
                          void perform(async () => {
                            await revokeSessionById(token, session.id);
                            setSessions(await loadSessions(token));
                          })
                        }
                      >
                        Отозвать
                      </button>
                    )}
                </article>
              ))}
          </section>
        </div>
        {current && section === "manage" && projectTab === "analytics" && (
          <ProjectAnalytics token={token} slug={current.slug} />
        )}
        {current && section === "manage" && projectTab === "versions" && (
          <section className="management-list">
            <h2>Версии {current.title}</h2>
            {releases.length ? (
              releases.map((release) => (
                <article key={release.id}>
                  <div>
                    <strong>
                      {release.version} ·{" "}
                      {release.channel === "stable"
                        ? "Стабильная"
                        : release.channel === "beta"
                          ? "Бета"
                          : "Альфа"}
                    </strong>
                    <span>
                      {publicationStatus(release.status)}
                      {release.deprecated ? " · устарела" : ""}
                    </span>
                    <p>{release.changelog || "Без описания изменений"}</p>
                    {release.review_reason && (
                      <p className="review-feedback">
                        Решение модератора: {release.review_reason}
                      </p>
                    )}
                  </div>
                  <div className="card-actions">
                    <button
                      onClick={() => confirmLifecycle(release, "deprecate")}
                    >
                      Устарела
                    </button>
                    <button
                      className="danger"
                      onClick={() => confirmLifecycle(release, "yank")}
                    >
                      Снять
                    </button>
                  </div>
                </article>
              ))
            ) : (
              <p>Релизов пока нет.</p>
            )}
          </section>
        )}
        {["owner", "admin", "moderator"].includes(account.role) &&
          section === "moderation" && (
            <PlatformAdmin token={token} role={account.role} username={account.username} />
          )}
      </fieldset>
      {pendingProject !== null && (
        <Modal
          title="Сохранить изменения проекта?"
          busy={working}
          close={() => setPendingProject(null)}
        >
          <p>В текущей карточке остались несохранённые изменения.</p>
          <div className="modal-actions">
            <button onClick={() => setPendingProject(null)}>Остаться</button>
            <button
              className="danger"
              onClick={() => {
                switchProject(pendingProject);
                setPendingProject(null);
              }}
            >
              Отменить изменения и перейти
            </button>
          </div>
        </Modal>
      )}
      {lifecycleDialog && (
        <Modal
          title={
            lifecycleDialog.action === "yank"
              ? "Снять версию с публикации?"
              : "Пометить версию устаревшей?"
          }
          busy={working}
          close={() => setLifecycleDialog(null)}
        >
          <p>
            Версия {lifecycleDialog.release.version}.{" "}
            {lifecycleDialog.action === "yank"
              ? "Она станет недоступна для новых установок. После снятия этот номер версии можно использовать повторно."
              : "Добавьте рекомендацию для пользователей этой версии."}
          </p>
          {lifecycleDialog.action === "deprecate" && (
            <label>
              Рекомендация
              <textarea
                value={lifecycleReason}
                onChange={(e) => setLifecycleReason(e.target.value)}
              />
            </label>
          )}
          <div className="modal-actions">
            <button disabled={working} onClick={() => setLifecycleDialog(null)}>
              Отмена
            </button>
            <button
              className="danger"
              disabled={working}
              onClick={() =>
                void perform(async () => {
                  await lifecycle(
                    lifecycleDialog.release,
                    lifecycleDialog.action,
                    lifecycleReason,
                  );
                  setLifecycleDialog(null);
                })
              }
            >
              Подтвердить
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function publicationStatus(status: string) {
  return (
    (
      {
        published: "Опубликован",
        draft: "Черновик",
        review: "На проверке",
        pending: "На проверке",
        processing: "Обработка",
        awaiting_moderation: "На проверке",
        rejected: "Отклонён",
        yanked: "Снят",
        blocked: "Заблокирован",
      } as Record<string, string>
    )[status] ?? status
  );
}
type ProjectKindInfo = {
  name: string;
  newTitle: string;
  description: string;
  choiceDescription: string;
  icon: IconName;
  titleLabel: string;
  titlePlaceholder: string;
  summaryLabel: string;
  summaryPlaceholder: string;
  descriptionLabel: string;
  createLabel: string;
};
const projectKinds: Record<Project["type"], ProjectKindInfo> = {
  mod: {
    name: "Контент-пак",
    newTitle: "Новый контент-пак",
    description: "Отдельное расширение игры: механика, блоки, интерфейс или библиотека для других паков.",
    choiceDescription: "Расширение или библиотека",
    icon: "package",
    titleLabel: "Название контент-пака",
    titlePlaceholder: "Как пак будет называться в каталоге",
    summaryLabel: "Коротко о контент-паке",
    summaryPlaceholder: "Что он добавляет или для чего нужен",
    descriptionLabel: "Описание контент-пака",
    createLabel: "Создать контент-пак",
  },
  modpack: {
    name: "Сборка",
    newTitle: "Новая сборка",
    description: "Готовая конфигурация игры с выбранной версией VoxelCore, контентом и настройками.",
    choiceDescription: "Готовый набор для игры",
    icon: "catalog",
    titleLabel: "Название сборки",
    titlePlaceholder: "Как сборка будет называться в каталоге",
    summaryLabel: "Коротко о сборке",
    summaryPlaceholder: "Какой игровой опыт она предлагает",
    descriptionLabel: "Описание сборки",
    createLabel: "Создать сборку",
  },
  world: {
    name: "Карта",
    newTitle: "Новая карта",
    description: "Готовый игровой мир: приключение, демонстрация, мини-игра или заготовка для строительства.",
    choiceDescription: "Опубликованный игровой мир",
    icon: "world",
    titleLabel: "Название карты",
    titlePlaceholder: "Как карта будет называться в каталоге",
    summaryLabel: "Коротко о карте",
    summaryPlaceholder: "Что ждёт игрока в этом мире",
    descriptionLabel: "Описание карты",
    createLabel: "Создать карту",
  },
  runtime: {
    name: "Среда выполнения",
    newTitle: "Новая среда выполнения",
    description: "Системный компонент VLauncher.",
    choiceDescription: "Системный компонент",
    icon: "terminal",
    titleLabel: "Название компонента",
    titlePlaceholder: "Название",
    summaryLabel: "Коротко о компоненте",
    summaryPlaceholder: "Назначение компонента",
    descriptionLabel: "Описание компонента",
    createLabel: "Создать компонент",
  },
};
function projectKindInfo(kind: string): ProjectKindInfo {
  return projectKinds[kind as Project["type"]] ?? projectKinds.mod;
}
function projectKind(kind: string) {
  return projectKindInfo(kind).name;
}

function creatorProjectImage(project?: CreatorProject) {
  return project?.cover_url || project?.preview_url || markdownImage(project?.description);
}
