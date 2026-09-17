import { AnalyticsConsent } from "./components/AnalyticsConsent";
import { VoxelWorldIntroduction } from "./components/VoxelWorldIntroduction";
import { recordActivity, recordContent } from "./telemetry";
import { useLocalResource, invalidateLocalResources } from "./useLocalResource";
import { AppUpdates } from "./components/AppUpdates";
import { profileIcon } from "./profileIcon";
import { popupMenu, contextMenuPosition } from "./desktop";
import { Select } from "./components/Select";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import {
  resolveProject,
  loadReleases,
  type RuntimeRelease,
  type SignedInstallPlan,
} from "./api";
import {
  engineVersion,
  exactVoxelCoreVersion,
  mainRuntimeId,
  profileRuntimeId,
  mainBuildLabel,
  profileEngineLabel,
  profileModpack,
  type MainBuild,
  requireEngineVersion,
  type LocalProfile,
  type Runtime,
  type GameEvent,
  type Task,
  type RunTask,
  formatBytes,
  friendlyError,
} from "./model";
import {
  Icon,
  Modal,
  Empty,
  ErrorNotice,
  type IconName,
} from "./components/ui";
import { Catalog, InstallPreview } from "./components/Catalog";
import {
  InstalledContentIcon,
  InstalledPackage,
  InstalledVoxelWorldIcon,
} from "./components/InstalledPackage";
import { useContentInspector, useInspectorNavigation } from "./components/ContentInspector";
import { ProfileContentPicker } from "./components/ProfileContentPicker";
import { Creator } from "./components/Creator";
import { Settings } from "./components/Settings";
import { useMainlineStatus } from "./components/Mainline";
import {
  appUpdateChannelKey,
  loadAppUpdateChannel,
  type AppUpdateChannel,
} from "./appUpdates";
import "./design-system/tokens.css";
import "./design-system/components.css";
import "./App.css";
import "./Workbench.css";

type Screen = "library" | "catalog" | "activity" | "creator" | "settings" | "content-picker";
type PendingPlan = {
  mainBuild?: MainBuild | null;
  profile: LocalProfile;
  plan: SignedInstallPlan;
  title: string;
  newProfileName?: string;
  allowVersionSkips?: boolean;
  coverUrl?: string;
};
type Confirmation = {
  title: string;
  text: string;
  label: string;
  action: () => Promise<unknown>;
  danger?: boolean;
};
type ExistingGameAnalysis = {
  suggested_name: string;
  runtime_kind: "manifest" | "detected" | "none";
  runtime_version: string | null;
  content_count: number;
  world_count: number;
  has_config: boolean;
};
const navigation: { id: Screen; title: string; icon: IconName }[] = [
  { id: "library", title: "Библиотека", icon: "library" },
  { id: "catalog", title: "Каталог", icon: "catalog" },
  { id: "activity", title: "Журнал", icon: "activity" },
];
const storedTasks = (): Task[] => {
  try {
    const value = JSON.parse(localStorage.getItem("vlauncher.tasks") ?? "[]") as Task[];
    return Array.isArray(value) ? value.slice(0, 100) : [];
  } catch {
    return [];
  }
};

export default function App() {
  const inspect = useContentInspector();
  const [screen, setScreen] = useState<Screen>("library");
  const visited = useRef(new Set<Screen>());
  visited.current.add(screen);
  const mainElement = useRef<HTMLElement>(null);
  const scrollPositions = useRef(new Map<string,number>());
  useLayoutEffect(() => { const el=mainElement.current; if(!el)return; el.scrollTop=scrollPositions.current.get(screen)??0; const save=()=>scrollPositions.current.set(screen,el.scrollTop); el.addEventListener('scroll',save);return()=>el.removeEventListener('scroll',save); },[screen]);
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [availableRuntimes, setAvailableRuntimes] = useState<RuntimeRelease[]>([]);
  const [runtimeCatalogError, setRuntimeCatalogError] = useState("");
  const [runtimeCatalogRevision, setRuntimeCatalogRevision] = useState(0);
  const reloadRuntimes = () => setRuntimeCatalogRevision((n) => n + 1);
  const [selected, setSelected] = useState(
    () => localStorage.getItem("vlauncher.profile") ?? "",
  );
  const [running, setRunning] = useState(new Set<string>());
  const [discordEnabled, setDiscordEnabled] = useState(() => localStorage.getItem("vlauncher.discord") !== "false");
  const [updateChannel, setUpdateChannel] = useState<AppUpdateChannel>(loadAppUpdateChannel);
  useEffect(() => {
    localStorage.setItem("vlauncher.discord", String(discordEnabled));
    void invoke("update_discord_presence", {enabled:discordEnabled, playing:running.size > 0}).catch(() => {});
  }, [discordEnabled, running.size]);
  useEffect(() => {
    localStorage.setItem(appUpdateChannelKey, updateChannel);
  }, [updateChannel]);
  const [logs, setLogs] = useState<GameEvent[]>([]);
  const [tasks, setTasks] = useState<Task[]>(storedTasks);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [gameFailure, setGameFailure] = useState<{
    profileId: string;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const taskLock = useRef(false);
  const [newProfile, setNewProfile] = useState(false);
  const [existingGame, setExistingGame] = useState<{
    path: string;
    analysis: ExistingGameAnalysis;
  } | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [deepLink, setDeepLink] = useState("");
  const [catalogReset, setCatalogReset] = useState(0);
  const registerInspectorNavigation = useInspectorNavigation();
  useEffect(() => {
    registerInspectorNavigation(ref => {
      setDeepLink(ref.source === "vspace" ? ref.slug : `${ref.source}:${ref.slug}`);
      setScreen("catalog");
    });
    return () => registerInspectorNavigation(null);
  }, [registerInspectorNavigation]);
  const [pickerProfileId, setPickerProfileId] = useState("");
  const [transferActive, setTransferActive] = useState(false);
  const [officialTransfer, setOfficialTransfer] = useState(false);
  const [worldPublish, setWorldPublish] = useState<{ profileId: string; folder: string } | null>(null);
  const [closeWithGame, setCloseWithGame] = useState(false);
  const [tab, setTab] = useState("content");
  const openCatalog = useCallback(() => {
    setDeepLink("");
    setCatalogReset((value) => value + 1);
    setScreen("catalog");
  }, []);
  const profile = profiles.find((p) => p.id === selected) ?? profiles[0];
  const installedModpack = profileModpack(profile);
  const currentTask = tasks[0];
  useEffect(() => {
    localStorage.setItem("vlauncher.tasks", JSON.stringify(tasks.slice(0, 100)));
  }, [tasks]);

  const refresh = useCallback(async () => {
    invalidateLocalResources();
    const [nextProfiles, nextRuntimes, nextRunning] = await Promise.all([
      invoke<LocalProfile[]>("list_profiles"),
      invoke<Runtime[]>("list_runtimes"),
      invoke<string[]>("running_profiles"),
    ]);
    setProfiles(nextProfiles);
    setRuntimes(nextRuntimes);
    setRunning(new Set(nextRunning));
    setLoadError("");
  }, []);
  useEffect(() => {
    const subscription = listen("close-requested-with-game", () => setCloseWithGame(true));
    return () => { void subscription.then((unlisten) => unlisten()); };
  }, []);
  useEffect(() => {
    const subscription = listen<{
      completed: number; total: number; bytes_per_second: number; eta_seconds: number;
    }>("transfer-progress", ({ payload }) => {
      setTransferActive(payload.completed < payload.total);
      const detail = `${formatBytes(payload.completed)} из ${formatBytes(payload.total)} · ${formatBytes(payload.bytes_per_second)}/с${payload.eta_seconds ? ` · около ${payload.eta_seconds} с` : ""}`;
      setTasks((items) => {
        const index = items.findIndex((item) => item.status === "working");
        if (index < 0) return items;
        return items.map((item, current) => current === index ? { ...item, detail } : item);
      });
    });
    return () => { void subscription.then((unlisten) => unlisten()); };
  }, []);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      await refresh();
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [refresh]);
  useEffect(() => {
    let active = true;
    void invoke<RuntimeRelease[]>("list_official_runtimes")
      .then((items) => {
        if (active) {
          setAvailableRuntimes(items);
          setRuntimeCatalogError("");
        }
      })
      .catch((error) => {
        if (active) setRuntimeCatalogError(String(error));
      });
    return () => {
      active = false;
    };
  }, [runtimeCatalogRevision]);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        // Не меняем страницу, пока открыта форма.
        if (document.querySelector("dialog[open]")) return;
        openCatalog();
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>(".search input")?.focus());
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, [openCatalog]);
  const run: RunTask = useCallback(async (title, work) => {
    if (taskLock.current) return false;
    taskLock.current = true;
    setBusy(true);
    const id = Date.now();
    setTasks((items) =>
      [
        {
          id,
          title,
          detail: "Подготовка…",
          status: "working" as const,
          time: new Date().toLocaleTimeString("ru", {
            hour: "2-digit",
            minute: "2-digit",
          }),
        },
        ...items,
      ].slice(0, 100),
    );
    const update = (data: Partial<Task>) =>
      setTasks((items) =>
        items.map((item) => (item.id === id ? { ...item, ...data } : item)),
      );
    try {
      await work((detail) => update({ detail }));
      update({ status: "done", detail: "Готово" });
      return true;
    } catch (e) {
      update({ status: "error", detail: friendlyError(e) });
      return false;
    } finally {
      taskLock.current = false;
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (profile) localStorage.setItem("vlauncher.profile", profile.id);
  }, [profile]);
  useEffect(() => {
    const append = (payload: GameEvent) =>
      setLogs((items) => [...items.slice(-1999), payload]);
    const log = listen<GameEvent>("game-log", ({ payload }) => append(payload));
    const exit = listen<GameEvent>("game-exit", ({ payload }) => {
      append(payload);
      if (payload.success === false) {
        setGameFailure({
          profileId: payload.profile_id,
          message: `VoxelCore завершился с ошибкой: ${payload.message}`,
        });
        setTasks((items) =>
          [
            {
              id: Date.now(),
              title: "Игра завершилась с ошибкой",
              detail: payload.message,
              status: "error" as const,
              time: new Date().toLocaleTimeString("ru", {
                hour: "2-digit",
                minute: "2-digit",
              }),
            },
            ...items,
          ].slice(0, 100),
        );
      }
      setRunning((items) => {
        const next = new Set(items);
        next.delete(payload.profile_id);
        return next;
      });
    });
    return () => {
      void log.then((fn) => fn());
      void exit.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    const handle = (urls: string[]) => {
      for (const value of urls) {
        try {
          const url = new URL(value);
          const slug =
            url.protocol === "vlauncher:" && url.hostname === "project"
              ? url.pathname.slice(1)
              : "";
          if (/^[a-z_][a-z0-9_]{1,23}$/.test(slug)) {
            setDeepLink(slug);
            setScreen("catalog");
          }
        } catch {
          /* Битую внешнюю ссылку просто пропускаем. */
        }
      }
    };
    void getCurrent()
      .then((urls) => {
        if (urls) handle(urls);
      })
      .catch(() => {});
    const subscription = onOpenUrl(handle);
    return () => {
      void subscription.then((fn) => fn()).catch(() => {});
    };
  }, []);
  const folder = (section: string) => {
    if (profile)
      void run("Открытие папки", async () =>
        invoke("open_profile_folder", { profileId: profile.id, section }),
      );
  };
  const installEngine = async (
    version: string,
    stage: (message: string) => void,
    force = false,
  ) => {
    version = requireEngineVersion(version);
    if (!force && runtimes.some((r) => r.version === version)) return;
    stage(`Поиск VoxelCore ${version}…`);
    stage(`Загрузка официального VoxelCore ${version} с GitHub…`);
    setOfficialTransfer(true);
    try {
      await invoke("install_official_runtime", { version });
    } finally {
      setOfficialTransfer(false);
    }
  };
  const chooseExistingGame = async () => {
    const path = await open({ directory: true, multiple: false });
    if (!path) return;
    await run("Проверка существующей игры", async (stage) => {
      stage("Проверяем папку VoxelCore…");
      const analysis = await invoke<ExistingGameAnalysis>("analyze_existing_game", { path });
      setExistingGame({ path, analysis });
    });
  };
  const launchProfile = (profile: LocalProfile | null) => {
    if (!profile) return;
    setSelected(profile.id);
    setScreen("library");
    setTab("logs");
    void run(`Запуск · ${profile.name}`, async (stage) => {
      setGameFailure(null);
      const version = engineVersion(profile);
      if (profile.main_build) {
        if (!runtimes.some(r => r.version === mainRuntimeId(profile.main_build!))) {
          stage("Загрузка закреплённой сборки main…");
          setOfficialTransfer(true);
          try { await invoke("install_mainline_build", { build: profile.main_build }); }
          finally { setOfficialTransfer(false); }
        }
      } else if (!profile.external_runtime) await installEngine(version, stage);
      if (!profile.active_revision)
        await invoke("initialize_vanilla", { profileId: profile.id, version });
      stage("Запуск VoxelCore…");
      await invoke("launch_profile", {
        profileId: profile.id,
        runtimeVersion: profile.main_build ? mainRuntimeId(profile.main_build) : version,
      });
      recordActivity("game_start");
      await refresh();
    });
  };
  const launch = () => launchProfile(profile);
  const changeRoots = (
    roots: string[],
    title: string,
    preserveRequirements = true,
    allowVersionSkips = false,
  ) => {
    if (!profile) return;
    if (!roots.length) {
      setConfirmation({
        title,
        text: "Из профиля будет удалён весь установленный через каталог контент. Существующие миры сохранятся, но могут требовать эти пакеты.",
        label: "Удалить контент",
        danger: true,
        action: async () => {
          await invoke("clear_profile", { profileId: profile.id });
          await refresh();
        },
      });
    } else
      void run("Проверка зависимостей", async () => {
        let requirements = preserveRequirements
          ? Object.fromEntries(
              roots
                .filter((root) => profile.root_requirements?.[root])
                .map((root) => [root, profile.root_requirements![root]]),
            )
          : {};
        let targetEngine = engineVersion(profile);
        let channels = ["stable", "beta", "alpha"];
        const modpack = profileModpack(profile);
        if (!preserveRequirements && modpack && roots.includes(modpack.id)) {
          const releases = await loadReleases(modpack.id);
          const current = releases.find((release) => release.version === modpack.version);
          channels = current?.channel === "stable"
            ? ["stable"]
            : current?.channel
              ? ["stable", current.channel]
              : ["stable"];
          const target = releases.find(
            (release) =>
              channels.includes(release.channel) &&
              !release.deprecated &&
              !!release.download_url &&
              !!exactVoxelCoreVersion(release.voxelcore),
          );
          if (!target) throw new Error("У сборки нет доступной версии с закреплённым VoxelCore.");
          targetEngine = exactVoxelCoreVersion(target.voxelcore);
          requirements = { ...requirements, [modpack.id]: `=${target.version}` };
        }
        const plan = await resolveProject(
          roots,
          targetEngine,
          requirements,
          channels,
        );
        setPendingPlan({ profile, plan, title, allowVersionSkips });
      });
  };
  const changeRuntime = (target: LocalProfile, selection: string) => {
    const selectedMain = runtimes.find((runtime) => runtime.version === selection)?.main_build;
    if (selection === profileRuntimeId(target)) return;
    const prepare = async () => {
      const mainBuild = selectedMain
        ? await invoke<MainBuild>("resolve_mainline_version", { build: selectedMain })
        : null;
      const version = mainBuild?.engine_version ?? selection;
      if (!version) throw new Error("Не удалось определить версию VoxelCore");
      if (target.roots.length) {
        const plan = await resolveProject(
          target.roots,
          version,
          target.root_requirements ?? {},
          ["stable", "beta", "alpha"],
        );
        setPendingPlan({
          profile: target,
          plan,
          mainBuild,
          title: mainBuild
            ? `Перейти на ${mainBuildLabel(mainBuild)}`
            : `Перейти на VoxelCore ${version}`,
        });
      } else if (mainBuild) {
        await invoke("select_mainline_build", {
          profileId: target.id,
          build: mainBuild,
        });
        await refresh();
      } else {
        await invoke("change_vanilla_runtime", {
          profileId: target.id,
          version,
        });
        await refresh();
      }
    };
    void run("Проверка совместимости VoxelCore", prepare);
  };
  const importProfile = () =>
    void run("Создание профиля из файла", async (stage) => {
      const path = await open({
        multiple: false,
        filters: [{ name: "Профиль VLauncher", extensions: ["json"] }],
      });
      if (!path) return;
      const definition = await invoke<{
        main_build?: MainBuild | null;
        name: string;
        voxelcore_version: string;
        roots: string[];
        locked: { id: string; version: string; artifact_sha256: string }[];
      }>("read_profile_definition", { path });
      if (definition.main_build) {
        const status = await invoke<{enabled: boolean}>("mainline_status");
        if (!status.enabled) throw new Error("Профиль использует main. Сначала включите экспериментальные сборки в настройках.");
        definition.main_build = await invoke<MainBuild>("resolve_mainline_version", { build: definition.main_build });
        definition.voxelcore_version = definition.main_build.engine_version!;
      }
      stage("Проверка доступности контента…");
      const plan = definition.roots.length
        ? await resolveProject(
            definition.roots,
            definition.voxelcore_version,
            {},
            ["stable", "beta", "alpha"],
            Object.fromEntries(
              (definition.locked ?? []).map((item) => [item.id, item.version]),
            ),
          )
        : null;
      for (const expected of definition.locked ?? []) {
        const actual = plan?.plan.packages.find((item) => item.id === expected.id);
        if (!actual || actual.artifact_sha256 !== expected.artifact_sha256)
          throw new Error(
            `Пакет ${expected.id} ${expected.version} больше не совпадает с экспортированной сборкой`,
          );
      }
      if (plan) {
        setPendingPlan({
          profile: {
            id: "pending-import",
            main_build: definition.main_build,
            name: definition.name,
            active_revision: null,
            voxelcore_version: definition.voxelcore_version,
            roots: [],
            root_requirements: {},
            packages: [],
          },
          plan,
          title: "Импорт контента",
          mainBuild: definition.main_build,
          newProfileName: definition.name,
        });
      } else {
        const created = await invoke<LocalProfile>("create_initialized_profile", {
          name: definition.name,
          version: definition.voxelcore_version,
          mainBuild: definition.main_build ?? null,
        });
        await refresh();
        setSelected(created.id);
        setScreen("library");
      }
    });

  return (
    <div className="app-shell workbench" data-screen={screen}>
      <aside className="sidebar">
        <div className="brand">
          <span className="sr-only">VLauncher</span>
          <span className="brand-wordmark" aria-hidden="true">
            <svg viewBox="0 0 432 512" fill="currentColor" focusable="false">
              <path d="M0 0h112l104 360L320 0h112L272 512H160Z" />
            </svg>
            <span>Launcher</span>
          </span>
        </div>
        <nav aria-label="Основная навигация">
          {navigation.map((item) => (
            <button
              key={item.id}
              className={screen === item.id ? "active" : ""}
              aria-current={screen === item.id ? "page" : undefined}
              onClick={() => {
                if (item.id === "catalog") openCatalog();
                else setScreen(item.id);
              }}
            >
              <Icon name={item.icon} />
              {item.title}
              {item.id === "activity" && busy && (
                <span className="status-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-profiles">
          <div className="sidebar-label supporting-label">
            Профили
            <button
              className="icon-button"
              aria-label="Создать профиль"
              disabled={busy || !!loadError}
              onClick={() => setNewProfile(true)}
            >
              <Icon name="plus" size={16} />
            </button>
          </div>
          {profiles.map((p) => (
            <button
              key={p.id}
              className={`profile-link ${profile?.id === p.id && screen === "library" ? "selected" : ""}`}
              onContextMenu={(event) => {
                event.preventDefault();
                void popupMenu([
                  { text: "Открыть профиль", action: () => { setSelected(p.id); setScreen("library"); } },
                  { text: running.has(p.id) ? "Завершить игру" : "Играть", enabled: !busy, action: () => {
                    if (running.has(p.id)) void run("Завершение игры", async () => { await invoke("stop_profile", {profileId:p.id}); await refresh(); });
                    else launchProfile(p);
                  } },
                  { item: "Separator" },
                  { text: "Открыть папку профиля", action: () => {
                    void run("Открытие папки", async () => invoke("open_profile_folder", {profileId:p.id, section:"game"}));
                  } },
                  { text: "Управление профилем", action: () => { setSelected(p.id); setScreen("library"); setTab("manage"); } },
                ], contextMenuPosition(event));
              }}
              onClick={() => {
                setSelected(p.id);
                setScreen("library");
              }}
            >
              <span className="profile-initial">
                {p.icon ? <img src={p.icon} alt="" /> : p.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                {p.name}
                <small>
                  {engineVersion(p) || "Версия не выбрана"}
                  {running.has(p.id) ? " · запущена" : ""}
                </small>
              </span>
            </button>
          ))}
          {!profiles.length && !loading && (
            <p className="sidebar-hint">Ваши игры появятся здесь</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={screen === "creator" ? "active" : ""}
            onClick={() => setScreen("creator")}
          >
            <Icon name="workshop" />
            Мастерская
          </button>
          <button
            className={screen === "settings" ? "active" : ""}
            onClick={() => setScreen("settings")}
          >
            <Icon name="settings" />
            Настройки
          </button>
        </div>
      </aside>
      <div className="workspace">
        <main id="main-content" ref={mainElement}>
          <AnalyticsConsent />
          <VoxelWorldIntroduction openCatalog={openCatalog} />
          <AppUpdates channel={updateChannel} running={running.size > 0} busy={busy} run={run} />
          {gameFailure && (
            <div className="notice error" role="alert">
              <div className="notice-copy">
                <strong>{gameFailure.message}</strong>
                <p>Откройте вывод игры, чтобы увидеть причину.</p>
              </div>
              <div className="notice-actions">
                <button
                  onClick={() => {
                    setSelected(gameFailure.profileId);
                    setScreen("library");
                    setTab("logs");
                  }}
                >
                  Открыть логи
                </button>
                <button
                  className="icon-button"
                  aria-label="Скрыть сообщение об ошибке игры"
                  onClick={() => setGameFailure(null)}
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            </div>
          )}
          {loadError && (
            <ErrorNotice retry={() => void load()}>
              <strong>Не удалось прочитать библиотеку</strong>
              <p>{loadError}</p>
            </ErrorNotice>
          )}
          {screen === "library" && (
            <div className="library-page">
              <header className="page-heading">
                <div>
                  <h1>Библиотека</h1>
                </div>
                <div className="actions">
                  <button
                    disabled={busy || !!loadError}
                    title="Использовать существующую папку игры без переноса файлов"
                    onClick={() => void chooseExistingGame()}
                  >
                    <Icon name="plus" size={16} />
                    Подключить папку
                  </button>
                  <button
                    disabled={busy || !!loadError}
                    title="Создать профиль из файла с версией VoxelCore и списком пакетов"
                    onClick={importProfile}
                  >
                    <Icon name="download" size={16} />
                    Создать из файла
                  </button>
                  <button
                    disabled={busy || !!loadError}
                    onClick={() => setNewProfile(true)}
                  >
                    <Icon name="plus" size={16} />
                    Новый профиль
                  </button>
                </div>
              </header>
              {loading ? (
                <div className="loading" role="status">
                  Читаем библиотеку…
                </div>
              ) : !profile && !loadError ? (
                <div className="library-welcome">
                  <Empty icon="library" title="Начните с чистого профиля">
                    <p>
                      Создайте профиль - отдельный набор со своими контент-паками,
                      <br />
                      мирами и настройками.
                    </p>
                    <button
                      className="primary"
                      onClick={() => setNewProfile(true)}
                    >
                      <Icon name="plus" />
                      Создать профиль
                    </button>
                    <button className="text-button" onClick={() => void chooseExistingGame()}>
                      Подключить существующую папку
                    </button>
                  </Empty>
                </div>
              ) : (
                profile && (
                  <>
                    <section className="game-heading">
                      {profile.icon && (
                        <div className="game-emblem"><img src={profile.icon} alt="" /></div>
                      )}
                      <div className="game-title">
                        <span className="eyebrow supporting-label">VoxelCore {profileEngineLabel(profile) || "· версия не выбрана"}</span>
                        {profile.main_build && <p>Экспериментальная сборка. Совместимость модов не подтверждена.</p>}
                        <h2>{profile.name}</h2>
                        {profile.external_game_path && (
                          <span className="attached-profile-path selectable" title={profile.external_game_path}>
                            Подключённая папка · {profile.external_game_path}
                          </span>
                        )}
                        {installedModpack && (
                          <button
                            className="profile-modpack-link"
                            onClick={() => inspect({ source: "vspace", slug: installedModpack.id, title: installedModpack.title || installedModpack.id, version: installedModpack.version, parent: profile.name, engine: engineVersion(profile) })}
                          >
                            Сборка {installedModpack.title || installedModpack.id} · {installedModpack.version}
                          </button>
                        )}
                        <p>
                          <span
                            className={`status-dot ${running.has(profile.id) ? "live" : ""}`}
                          />
                          {running.has(profile.id)
                            ? "Игра запущена"
                            : !engineVersion(profile) ? "Выберите версию в разделе «Управление»" : profile.external_runtime || runtimes.some(
                                  (r) => r.version === profileRuntimeId(profile),
                                )
                              ? "Готов к запуску"
                              : "Требуется загрузка игры"}
                        </p>
                      </div>
                      <div className="launch-area">
                        {running.has(profile.id) ? (
                          <button
                            disabled={busy}
                            onClick={() =>
                              setConfirmation({
                                title: "Завершить игру?",
                                text: "Сначала сохраните мир и выйдите через меню VoxelCore. Принудительное завершение может потерять несохранённые изменения.",
                                label: "Завершить принудительно",
                                danger: true,
                                action: async () =>
                                  invoke("stop_profile", {
                                    profileId: profile.id,
                                  }),
                              })
                            }
                          >
                            Завершить игру
                          </button>
                        ) : (
                          <button
                            className="primary launch"
                            disabled={busy || !!loadError || !!profile.problem || !engineVersion(profile)}
                            onClick={launch}
                          >
                            <Icon name="play" />
                            {busy
                              ? "Подождите…"
                              : !engineVersion(profile) ? "Версия не выбрана" : profile.external_runtime || runtimes.some(
                                    (r) => r.version === profileRuntimeId(profile),
                                  )
                                ? "Играть"
                                : "Установить и играть"}
                          </button>
                        )}
                        {running.has(profile.id) && (
                          <small>Контент доступен только для просмотра</small>
                        )}
                      </div>
                    </section>
                    {profile.problem && (
                      <ErrorNotice>
                        <strong>{profile.external_game_path && profile.problem === "Подключённая папка игры недоступна" ? "Подключённая папка недоступна" : "Профиль требует восстановления"}</strong>
                        <p>{profile.external_game_path && profile.problem === "Подключённая папка игры недоступна"
                          ? "Игра могла быть перемещена или диск сейчас не подключён. Укажите новое расположение в управлении профилем."
                          : "Данные профиля повреждены или отсутствуют. Остальные профили доступны."}</p>
                        {profile.external_game_path && profile.problem === "Подключённая папка игры недоступна" && (
                          <button onClick={() => setTab("manage")}>Изменить путь…</button>
                        )}
                        <details>
                          <summary>Технические подробности</summary>
                          {profile.problem}
                        </details>
                      </ErrorNotice>
                    )}
                    <div
                      className="tab-bar"
                      role="tablist"
                      aria-label="Профиль"
                    >
                      {[
                        ["content", "Контент"],
                        ["worlds", "Миры"],
                        ["logs", "Логи"],
                        ["manage", "Управление"],
                      ].map(([id, title]) => (
                        <button
                          key={id}
                          role="tab"
                          aria-selected={tab === id}
                          className={tab === id ? "active" : ""}
                          onClick={() => setTab(id)}
                        >
                          {title}
                          {id === "content" && (
                            <span className="count">
                              {profile.packages.length + (profile.external_packages?.length ?? 0)}
                            </span>
                          )}
                          {id === "logs" && logs.some((item) => item.profile_id === profile.id) && (
                            <span className="count">
                              {logs.filter((item) => item.profile_id === profile.id).length}
                            </span>
                          )}
                        </button>
                      ))}
                      <button
                        className="folder-shortcut"
                        onClick={() => folder("game")}
                        disabled={busy}
                      >
                        <Icon name="folder" size={16} />
                        Папка профиля
                      </button>
                    </div>
                    <section
                      role="tabpanel"
                      aria-label={
                        tab === "content"
                          ? "Контент"
                          : tab === "worlds"
                            ? "Миры"
                            : tab === "logs"
                              ? "Логи"
                              : "Управление"
                      }
                    >
                      {tab === "content" && (
                        <>
                          <div className="section-heading">
                            <div>
                              <h3>Установленный контент</h3>
                              <p>
                                Набор пакетов профиля. Включение для конкретного
                                мира - в игре.
                              </p>
                            </div>
                            <div className="actions">
                              {!!profile.roots.length && (
                                <button
                                  disabled={busy || running.has(profile.id)}
                                  onClick={() =>
                                    changeRoots(
                                      profile.roots,
                                      "Проверка обновлений",
                                      false,
                                      true,
                                    )
                                  }
                                >
                                  {installedModpack ? "Проверить обновление сборки" : "Проверить обновления"}
                                </button>
                              )}
                              <button
                                disabled={busy}
                                onClick={() => { setPickerProfileId(profile.id); setScreen("content-picker"); }}
                              >
                                <Icon name="plus" size={16} />
                                Добавить
                              </button>
                            </div>
                          </div>
                          {!profile.packages.some((pkg) => pkg.kind !== "modpack") && !profile.external_packages?.length && !profile.manual_packages?.length ? (
                            <Empty title="Чистая игра">
                              <p>
                                Контент-паков пока нет. Можно играть сразу
                                <br />
                                или подобрать контент в каталоге.
                              </p>
                              <button onClick={() => { setPickerProfileId(profile.id); setScreen("content-picker"); }}>
                                <Icon name="catalog" size={16} />
                                Открыть каталог
                              </button>
                            </Empty>
                          ) : (
                            <div className="content-list">
                              <div className="list-heading supporting-label">
                                <span>Пакет</span>
                                <span>Версия</span>
                                <span />
                              </div>
                              {[...profile.packages]
                                .filter((pkg) => pkg.kind !== "modpack")
                                .sort(
                                  (a, b) =>
                                    Number(profile.roots.includes(b.id)) -
                                    Number(profile.roots.includes(a.id)),
                                )
                                .map((pkg) => (
                                  <div className="content-row" key={pkg.id}>
                                    <InstalledPackage profileId={profile.id} pkg={pkg} root={profile.roots.includes(pkg.id)} open={() => {
                                      inspect({ source: "vspace", slug: pkg.id, title: pkg.title || pkg.id, version: pkg.version, parent: profile.name, engine: engineVersion(profile) });
                                    }} />
                                    <code>{pkg.version}</code>
                                    {profile.roots.includes(pkg.id) ? (
                                      <button
                                        className="icon-button"
                                        aria-label={`Удалить ${pkg.title || pkg.id}`}
                                        disabled={
                                          busy || running.has(profile.id)
                                        }
                                        onClick={() =>
                                          changeRoots(
                                            profile.roots.filter(
                                              (root) => root !== pkg.id,
                                            ),
                                            `Удаление ${pkg.id}`,
                                          )
                                        }
                                      >
                                        <Icon name="close" size={16} />
                                      </button>
                                    ) : (
                                      <span className="row-spacer" />
                                    )}
                                  </div>
                                ))}
                              {profile.external_packages?.map((pkg) => (
                                <div className="content-row" key={`voxelworld-${pkg.project_id}`}>
                                  <span className="package-symbol">
                                    <InstalledVoxelWorldIcon
                                      profileId={profile.id}
                                      packageId={pkg.id}
                                      slug={pkg.slug}
                                    />
                                  </span>
                                  <div className="grow">
                                    <button className="dependency-project-link" onClick={() => inspect({ source: pkg.source, slug: pkg.slug, title: pkg.title, version: pkg.version, versionId: pkg.version_id, parent: profile.name })}>{pkg.title}</button>
                                    <small>VoxelWorld · управляется VLauncher</small>
                                  </div>
                                  <code>{pkg.version}</code>
                                  <button
                                    className="icon-button"
                                    aria-label={`Удалить ${pkg.title}`}
                                    disabled={busy || running.has(profile.id)}
                                    onClick={() =>
                                      void run(`Удаление ${pkg.title}`, async () => {
                                        await invoke("remove_voxelworld_mod", {
                                          profileId: profile.id,
                                          id: pkg.id,
                                        });
                                        await refresh();
                                      })
                                    }
                                  >
                                    <Icon name="close" size={16} />
                                  </button>
                                </div>
                              ))}
                              {profile.manual_packages?.map((id) => (
                                <div className="content-row" key={`manual-${id}`}>
                                  <span className="package-symbol">
                                    <InstalledContentIcon
                                      profileId={profile.id}
                                      packageId={id}
                                      fallbackIcon="folder"
                                    />
                                  </span>
                                  <div className="grow">
                                    <button className="dependency-project-link" onClick={() => inspect({ source: "local", slug: id, parent: profile.name })}>{id}</button>
                                    <small>Добавлен вручную · лаунчер не обновляет эти файлы</small>
                                  </div>
                                  <code>локальный</code>
                                  <button
                                    className="icon-button"
                                    aria-label={`Открыть папку ${id}`}
                                    disabled={busy}
                                    onClick={() => folder("content")}
                                  >
                                    <Icon name="folder" size={16} />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                      {tab === "worlds" && (
                        <Worlds
                          key={profile.id}
                          profile={profile}
                          folder={() => folder("worlds")}
                          catalog={openCatalog}
                          busy={busy}
                          run={run}
                          publish={(worldFolder) => {
                            setWorldPublish({ profileId: profile.id, folder: worldFolder });
                            setScreen("creator");
                          }}
                        />
                      )}
                      {tab === "logs" && (
                        <ProfileLogs
                          profile={profile}
                          logs={logs.filter((item) => item.profile_id === profile.id)}
                          running={running.has(profile.id)}
                          clear={() => setLogs((items) => items.filter((item) => item.profile_id !== profile.id))}
                        />
                      )}
                      {tab === "manage" && (
                        <ProfileSettings
                          key={profile.id}
                          profile={profile}
                          runtimes={runtimes}
                          busy={busy || running.has(profile.id)}
                          run={run}
                          refresh={refresh}
                          confirm={setConfirmation}
                          select={setSelected}
                          availableRuntimes={[
                            ...availableRuntimes,
                            ...runtimes.filter(runtime => !runtime.main_build && !availableRuntimes.some(item => item.version === runtime.version))
                              .map(runtime => ({version: runtime.version, channel: "local", artifact_size: 0, published_at: ""})),
                          ]}
                          changeRuntime={(version) => changeRuntime(profile, version)}
                        />
                      )}
                    </section>
                  </>
                )
              )}
            </div>
          )}
          {pickerProfileId && profiles.some(item => item.id === pickerProfileId) && <div hidden={screen !== "content-picker"}>
            <ProfileContentPicker key={pickerProfileId} profile={profiles.find(item => item.id === pickerProfileId)!}
              active={screen === "content-picker"} refreshProfiles={refresh}
              busy={busy} running={running.has(pickerProfileId)} run={run} preview={setPendingPlan}
              openProfile={(id) => { setSelected(id); setScreen("library"); }}
              close={() => { setSelected(pickerProfileId); setScreen("library"); }} />
          </div>}
          {visited.current.has("catalog") && (
            <div hidden={screen !== "catalog"}><Catalog
              active={screen === "catalog"}
              profiles={profiles}
              selected={profile?.id ?? ""}
              select={setSelected}
              busy={busy}
              running={running}
              run={run}
              preview={setPendingPlan}
              deepLink={deepLink}
              resetDetail={catalogReset}
              create={() => setNewProfile(true)}
              openProfile={(id) => { setSelected(id); setScreen("library"); }}
              refreshProfiles={refresh}
            /></div>
          )}
          {screen === "activity" && (
            <Activity
              tasks={tasks}
              logs={logs}
              profiles={profiles}
              clearLogs={() => setLogs([])}
              clearTasks={() => setTasks([])}
            />
          )}
          <div hidden={screen !== "creator"}>
            {visited.current.has("creator") && <Creator active={screen === "creator"} worldPublish={worldPublish} />}
          </div>
          {screen === "settings" && (
            <Settings
              gameRunning={running.size > 0}
              updateChannel={updateChannel}
              setUpdateChannel={setUpdateChannel}
              discordEnabled={discordEnabled}
              setDiscordEnabled={setDiscordEnabled}
              runtimes={runtimes}
              availableRuntimes={availableRuntimes}
              runtimeCatalogError={runtimeCatalogError}
              reloadRuntimes={reloadRuntimes}
              usedVersions={new Set(profiles.flatMap(item => item.external_runtime ? [] : [engineVersion(item), ...(item.main_build ? [mainRuntimeId(item.main_build)] : [])]))}
              busy={busy}
              run={run}
              refresh={refresh}
              install={async (version) => {
                await run(`Установка VoxelCore ${version}`, async (stage) => {
                  await installEngine(version, stage, true);
                  await refresh();
                });
              }}
              installMainline={build => run(`Установка ${mainBuildLabel(build)}`, async () => {
                setOfficialTransfer(true);
                try { await invoke("install_mainline_build", { build }); await refresh(); }
                finally { setOfficialTransfer(false); }
              })}
              remove={(version) =>
                setConfirmation({
                  title: `Удалить VoxelCore ${runtimes.find(r => r.version === version)?.main_build ? mainBuildLabel(runtimes.find(r => r.version === version)!.main_build!) : version}?`,
                  text: "Файлы этой версии движка будут удалены. Профили и миры сохранятся.",
                  label: "Удалить версию",
                  danger: true,
                  action: async () => {
                    await invoke("remove_runtime", { version });
                    await refresh();
                  },
                })
              }
            />
          )}
        </main>
        <footer
          className={`statusbar ${currentTask?.status === "error" ? "has-error" : ""}`}
          aria-live="polite"
        >
          <span>
            {currentTask ? (
              <>
                <span className={`status-dot ${busy ? "live" : ""}`} />
                {currentTask.title}
                <span className="status-detail">
                  {currentTask.status === "error"
                    ? "Не удалось выполнить"
                    : currentTask.detail}
                </span>
              </>
            ) : (
              <>
                <span className="status-dot" />
                Локальная библиотека
              </>
            )}
          </span>
          {busy && transferActive && (
            <button onClick={() => void invoke("cancel_transfer")}>{officialTransfer ? "Отменить загрузку" : "Приостановить"}</button>
          )}
          <button onClick={() => setScreen("activity")}>
            {currentTask?.status === "error" ? "Показать ошибку" : "Журнал"}
            <Icon name="activity" size={14} />
          </button>
        </footer>
      </div>
      {newProfile && (
        <CreateProfile
          runtimes={runtimes}
          availableRuntimes={availableRuntimes}
          runtimeCatalogError={runtimeCatalogError}
              reloadRuntimes={reloadRuntimes}
          busy={busy}
          close={() => setNewProfile(false)}
          submit={async (name, version, mainBuild) => {
            const ok = await run("Создание профиля", async () => {
              const p = await invoke<LocalProfile>("create_initialized_profile", {
                name,
                version,
                mainBuild: mainBuild ?? null,
              });
              await refresh();
              setSelected(p.id);
              setTab("content");
              setScreen("library");
            });
            if (ok) setNewProfile(false);
            return ok;
          }}
        />
      )}
      {existingGame && (
        <ImportExistingGame
          source={existingGame.path}
          analysis={existingGame.analysis}
          runtimes={runtimes}
          availableRuntimes={availableRuntimes}
          runtimeCatalogError={runtimeCatalogError}
          reloadRuntimes={reloadRuntimes}
          busy={busy}
          close={() => setExistingGame(null)}
          submit={async (name, version) => {
            const ok = await run("Добавление существующей игры", async (stage) => {
              if (existingGame.analysis.runtime_kind === "none") {
                await installEngine(version, stage);
              }
              stage("Подключаем папку к новому профилю…");
              const created = await invoke<LocalProfile>("attach_existing_game", {
                path: existingGame.path,
                name,
                version,
              });
              await refresh();
              setSelected(created.id);
              setTab("content");
              setScreen("library");
            });
            if (ok) setExistingGame(null);
            return ok;
          }}
        />
      )}
      {closeWithGame && (
        <Modal title="VoxelCore ещё работает" close={() => setCloseWithGame(false)} busy={false}>
          <p>Игру можно оставить запущенной, но управлять ей из лаунчера уже не получится.</p>
          <div className="modal-actions">
            <button onClick={() => setCloseWithGame(false)}>Оставить лаунчер</button>
            <button className="primary" onClick={() => void invoke("exit_launcher")}>Закрыть лаунчер</button>
          </div>
        </Modal>
      )}
      {pendingPlan && (
        <InstallPreview
          {...pendingPlan}
          busy={busy}
          close={() => setPendingPlan(null)}
          skipVersion={
            pendingPlan.allowVersionSkips
              ? async (id, version) =>
                  run("Сохранение выбранной версии", async () => {
                    const plan = await resolveProject(
                      pendingPlan.plan.plan.roots,
                      pendingPlan.plan.plan.voxelcore_version,
                      {
                        ...pendingPlan.plan.plan.root_requirements,
                        [id]: `=${version}`,
                      },
                      ["stable", "beta", "alpha"],
                    );
                    setPendingPlan({ ...pendingPlan, plan });
                  })
              : undefined
          }
          apply={async () => {
            const ok = await run(
              `Установка · ${pendingPlan.profile.name}`,
              async (stage) => {
                if (
                  !pendingPlan.newProfileName &&
                  running.has(pendingPlan.profile.id)
                )
                  throw new Error("Сначала завершите игру");
                stage("Загрузка, проверка и установка пакетов…");
                let installedProfileId = pendingPlan.profile.id;
                if (pendingPlan.newProfileName) {
                  const created = await invoke<LocalProfile>(
                    "create_profile_from_plan",
                    {
                      name: pendingPlan.newProfileName,
                      plan: pendingPlan.plan,
                    },
                  );
                  installedProfileId = created.id;
                  if (pendingPlan.mainBuild) await invoke("select_mainline_build", { profileId: created.id, build: pendingPlan.mainBuild });
                  setSelected(created.id);
                  setScreen("library");
                } else {
                  await invoke("apply_remote_install_plan", {
                    profileId: pendingPlan.profile.id,
                    plan: pendingPlan.plan,
                  });
                  if (pendingPlan.mainBuild !== undefined)
                    await invoke("select_mainline_build", {
                      profileId: pendingPlan.profile.id,
                      build: pendingPlan.mainBuild,
                    });
                }
                for (const pack of pendingPlan.plan.plan.packages) recordContent(pack.id, "install", pack.version);
                if (pendingPlan.coverUrl && !pendingPlan.profile.icon) {
                  try {
                    const response = await fetch(pendingPlan.coverUrl, {signal:AbortSignal.timeout(15000)});
                    if (!response.ok) throw new Error("Обложка недоступна");
                    await invoke("set_profile_icon", {profileId:installedProfileId,icon:await profileIcon(await response.blob())});
                  } catch {
                    setTasks(items => [{id:Date.now(),title:"Обложка сборки",detail:"Сборка установлена, но иконка не загрузилась. Её можно выбрать позже в настройках профиля.",status:"error",time:new Date().toLocaleTimeString("ru",{hour:"2-digit",minute:"2-digit"})}, ...items]);
                  }
                }
                await refresh();
              },
            );
            if (ok) setPendingPlan(null);
            return ok;
          }}
        />
      )}
      {confirmation && (
        <Confirm
          {...confirmation}
          busy={busy}
          close={() => setConfirmation(null)}
          submit={async () => {
            const ok = await run(confirmation.title, confirmation.action);
            if (ok) setConfirmation(null);
            return ok;
          }}
        />
      )}
    </div>
  );
}

function ImportExistingGame({
  source,
  analysis,
  runtimes,
  availableRuntimes,
  runtimeCatalogError,
  reloadRuntimes,
  busy,
  close,
  submit,
}: {
  source: string;
  analysis: ExistingGameAnalysis;
  runtimes: Runtime[];
  availableRuntimes: RuntimeRelease[];
  runtimeCatalogError: string;
  reloadRuntimes: () => void;
  busy: boolean;
  close: () => void;
  submit: (name: string, version: string) => Promise<boolean>;
}) {
  const versions = [
    ...availableRuntimes,
    ...runtimes
      .filter(
        (runtime) =>
          !runtime.main_build &&
          !availableRuntimes.some((item) => item.version === runtime.version),
      )
      .map((runtime) => ({
        version: runtime.version,
        channel: "local" as const,
        artifact_size: 0,
        published_at: "",
      })),
  ];
  const initialVersion =
    analysis.runtime_version ??
    versions.find((item) => item.channel === "stable")?.version ??
    versions[0]?.version ??
    "";
  const [name, setName] = useState(analysis.suggested_name);
  const [version, setVersion] = useState(initialVersion);
  const [failed, setFailed] = useState(false);
  const recognizable =
    analysis.runtime_kind !== "none" ||
    analysis.content_count > 0 ||
    analysis.world_count > 0 ||
    analysis.has_config;
  const runtimeInstalled = runtimes.some((runtime) => runtime.version === version);
  const runtimeText =
    analysis.runtime_kind === "manifest"
      ? `Готовая среда VLauncher · VoxelCore ${analysis.runtime_version}`
      : analysis.runtime_kind === "detected"
        ? "Найдены исполняемый файл VoxelCore и ресурсы"
        : "Движок в папке не найден";

  return (
    <Modal title="Подключить существующую игру" close={close} busy={busy}>
      <form
        className="existing-game-import"
        onSubmit={(event) => {
          event.preventDefault();
          if (!recognizable || !name.trim() || !version) return;
          void submit(name.trim(), version).then((ok) => setFailed(!ok));
        }}
      >
        <p className="existing-game-source selectable" title={source}>{source}</p>
        <section className="existing-game-summary">
          <div>
            <strong>VoxelCore</strong>
            <span>{runtimeText}</span>
          </div>
          {analysis.runtime_kind !== "manifest" && (
            <span className="muted">
              {analysis.runtime_kind === "detected"
                ? analysis.runtime_version
                  ? `Версия ${analysis.runtime_version} определена командой --version`
                  : "Не удалось определить версию автоматически"
                : "Выбранная версия будет установлена обычным способом"}
            </span>
          )}
        </section>

        {!recognizable && (
          <ErrorNotice>
            В папке нет VoxelCore, контент-паков, миров или настроек. Выберите папку игры либо создайте обычный профиль.
          </ErrorNotice>
        )}

        <label>
          Название профиля
          <input
            autoFocus
            data-initial-focus
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.target.select()}
          />
        </label>

        {analysis.runtime_version ? (
          <div className="existing-game-fixed-version">
            <span>Версия VoxelCore</span>
            <strong>{analysis.runtime_version}</strong>
          </div>
        ) : (
          <label>
            Версия VoxelCore
            <Select
              required
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              disabled={!versions.length}
            >
              {versions.map((item) => (
                <option key={item.version} value={item.version}>
                  {item.version} · {item.channel === "stable" ? "стабильная" : item.channel === "local" ? "локальная" : item.channel}
                  {runtimes.some((runtime) => runtime.version === item.version)
                    ? " · установлена"
                    : ""}
                </option>
              ))}
            </Select>
            <small>
              {analysis.runtime_kind === "detected"
                ? "Будет запускаться найденный исполняемый файл; выбранная версия нужна для совместимости пакетов"
                : runtimeInstalled
                  ? "Уже установлена на компьютере"
                  : "Будет загружена и проверена"}
            </small>
          </label>
        )}

        <section className="existing-game-data" aria-label="Найденные данные">
          <h3>Найдено в папке</h3>
          <div><strong>{analysis.content_count}</strong><span>контент-паков</span></div>
          <div><strong>{analysis.world_count}</strong><span>миров</span></div>
          <div><strong>{analysis.has_config ? "Есть" : "Нет"}</strong><span>настройки config</span></div>
        </section>

        <p className="existing-game-note">
          Папка останется на своём месте и станет рабочей папкой профиля. Установка контента и изменения в игре будут сохраняться прямо в неё.
        </p>
        {runtimeCatalogError && !analysis.runtime_version && (
          <ErrorNotice retry={reloadRuntimes}>
            Не удалось загрузить список релизов. Можно выбрать уже установленную версию.
          </ErrorNotice>
        )}
        {failed && <ErrorNotice>Не удалось добавить игру. Подробности в журнале.</ErrorNotice>}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={close}>Отмена</button>
          <button
            className="primary"
            disabled={busy || !recognizable || !name.trim() || !version}
          >
            {busy ? "Подключаем…" : "Подключить профиль"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CreateProfile({
  runtimes,
  availableRuntimes,
  runtimeCatalogError,
  reloadRuntimes,
  busy,
  close,
  submit,
}: {
  runtimes: Runtime[];
  availableRuntimes: RuntimeRelease[];
  runtimeCatalogError: string;
  reloadRuntimes: () => void;
  busy: boolean;
  close: () => void;
  submit: (name: string, version: string, mainBuild?: MainBuild) => Promise<boolean>;
}) {
  const [name, setName] = useState("VoxelCore");
  const { status: mainlineStatus, error: mainlineError } = useMainlineStatus();
  const [selectedMainId, setSelectedMainId] = useState("");
  const [acceptedRisk, setAcceptedRisk] = useState(false);
  const mainBuilds = mainlineStatus.enabled
    ? runtimes.flatMap((runtime) => runtime.main_build ? [runtime.main_build] : [])
    : [];
  const selectedMain = mainBuilds.find((build) => mainRuntimeId(build) === selectedMainId);
  const [resolvedMain, setResolvedMain] = useState<MainBuild | null>(null);
  const [versionError, setVersionError] = useState("");
  const [versionRetry, setVersionRetry] = useState(0);
  const selectedVersion = selectedMain?.engine_version;
  useEffect(() => {
    let active = true;
    setResolvedMain(null);
    setVersionError("");
    if (selectedMain) {
      void invoke<MainBuild>("resolve_mainline_version", { build: selectedMain })
        .then((build) => { if (active) setResolvedMain(build); })
        .catch((error) => { if (active) setVersionError(String(error)); });
    }
    return () => { active = false; };
  }, [selectedMainId, selectedVersion, mainlineStatus.enabled, versionRetry]);
  const readyMain = resolvedMain && selectedMain && mainRuntimeId(resolvedMain) === selectedMainId ? resolvedMain : null;
  const versions = [
    ...availableRuntimes,
    ...runtimes
      .filter((runtime) => !runtime.main_build && !availableRuntimes.some((item) => item.version === runtime.version))
      .map((runtime) => ({
        version: runtime.version,
        channel: "local" as const,
        artifact_size: 0,
        published_at: "",
      })),
  ];
  const [version, setVersion] = useState(
    versions.find((item) => item.channel === "stable")?.version ?? versions[0]?.version ?? "",
  );
  const [versionChosen, setVersionChosen] = useState(false);
  const effectiveVersion = selectedMainId ? readyMain?.engine_version ?? "" : version;
  useEffect(() => {
    if (!versionChosen && availableRuntimes.length) {
      setVersion((availableRuntimes.find((item) => item.channel === "stable") ?? availableRuntimes[0]).version);
    }
  }, [availableRuntimes, versionChosen]);
  const [failed, setFailed] = useState(false);
  return (
    <Modal title="Новый профиль" close={close} busy={busy}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!effectiveVersion || (selectedMainId && (!readyMain || !acceptedRisk))) return;
          void submit(name.trim(), effectiveVersion, readyMain ?? undefined).then((ok) => setFailed(!ok));
        }}
      >
        <p>
          Свои миры, настройки и набор контент-паков. Другие профили хранятся отдельно.
        </p>
        <label>
          Название
          <input
            autoFocus
            data-initial-focus
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </label>
        <label>
          Версия VoxelCore
          <Select
            aria-label="Версия VoxelCore"
            required
            value={selectedMainId || version}
            onChange={(e) => {
              const main = mainBuilds.find((build) => mainRuntimeId(build) === e.target.value);
              setSelectedMainId(main ? e.target.value : "");
              setAcceptedRisk(false);
              if (!main) { setVersion(e.target.value); setVersionChosen(true); }
            }}
            disabled={!versions.length && !mainBuilds.length}
          >
            {mainBuilds.map((build) => (
              <option key={mainRuntimeId(build)} value={mainRuntimeId(build)}>
                {mainBuildLabel(build)} · экспериментальная · установлена
              </option>
            ))}
            {versions.map((item) => (
              <option key={item.version} value={item.version}>
                {item.version} · {item.channel === "stable" ? "стабильная" : item.channel === "local" ? "локальная сборка" : item.channel}
                {runtimes.some((runtime) => runtime.version === item.version)
                  ? " · установлена"
                  : ""}
              </option>
            ))}
          </Select>
          <small>
            {selectedMain
              ? "Будет запускаться эта сборка main, а не стабильный релиз"
              : !versions.length
              ? "Нет доступных версий VoxelCore для этой системы"
              : runtimes.some((r) => r.version === version)
              ? "Уже установлена на компьютере"
              : "Будет загружена и проверена при первом запуске"}
          </small>
        </label>
        {selectedMain && (
          <>
            <p>{readyMain?.engine_version
              ? `Версия движка: ${readyMain.engine_version} · develop · ${readyMain.sha.slice(0, 7)}. Некоторые пакеты могут не работать с этой сборкой.`
              : "Определяем версию движка по коммиту…"}</p>
            {versionError && <ErrorNotice retry={() => setVersionRetry((value) => value + 1)}>{versionError}</ErrorNotice>}
            <label className="checkbox-row">
              <input type="checkbox" checked={acceptedRisk} onChange={(e) => setAcceptedRisk(e.target.checked)} />
              Понимаю риск ошибок и повреждения миров в экспериментальной сборке
            </label>
          </>
        )}
        {mainlineStatus.enabled && !mainBuilds.length && (
          <p className="muted">Сборку main сначала нужно установить в Настройках → Экспериментальное.</p>
        )}
        {mainlineError && <ErrorNotice>{mainlineError}</ErrorNotice>}
        {runtimeCatalogError && (
          <ErrorNotice retry={reloadRuntimes}>
            Не удалось загрузить релизы с GitHub. Можно выбрать уже установленную версию.
          </ErrorNotice>
        )}
        {failed && (
          <ErrorNotice>
            Не удалось создать профиль. Подробности в журнале.
          </ErrorNotice>
        )}
        <div className="modal-actions">
          <button type="button" disabled={busy} onClick={close}>
            Отмена
          </button>
          <button className="primary" disabled={busy || !name.trim() || !effectiveVersion || (!!selectedMainId && (!readyMain || !acceptedRisk))}>
            {busy ? "Создаём…" : "Создать профиль"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Confirm({
  title,
  text,
  label,
  danger,
  busy,
  close,
  submit,
}: Confirmation & {
  busy: boolean;
  close: () => void;
  submit: () => Promise<boolean>;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <Modal title={title} close={close} busy={busy}>
      <p>{text}</p>
      {failed && (
        <ErrorNotice>
          Не удалось выполнить действие. Подробности в журнале.
        </ErrorNotice>
      )}
      <div className="modal-actions">
        <button disabled={busy} onClick={close} autoFocus data-initial-focus>
          Отмена
        </button>
        <button
          className={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={() => void submit().then((ok) => setFailed(!ok))}
        >
          {busy ? "Подождите…" : label}
        </button>
      </div>
    </Modal>
  );
}
function ProfileSettings({
  profile,
  runtimes,
  busy,
  run,
  refresh,
  confirm,
  select,
  availableRuntimes,
  changeRuntime,
}: {
  profile: LocalProfile;
  runtimes: Runtime[];
  busy: boolean;
  run: RunTask;
  refresh: () => Promise<void>;
  confirm: (value: Confirmation) => void;
  select: (id: string) => void;
  availableRuntimes: { version: string; channel: string }[];
  changeRuntime: (version: string) => void;
}) {
  type ProfileStorage = {
    total_bytes: number;
    game_bytes: number;
    snapshot_bytes: number;
    reclaimable_bytes: number;
    snapshot_count: number;
  };
  const [name, setName] = useState(profile.name);
  const modpack = profileModpack(profile);
  const { status: mainlineStatus } = useMainlineStatus();
  const mainBuilds = runtimes.flatMap((runtime) => runtime.main_build ? [runtime.main_build] : []);
  const [runtimeVersion, setRuntimeVersion] = useState(profileRuntimeId(profile));
  const [acceptedMainRisk, setAcceptedMainRisk] = useState(false);
  useEffect(() => {
    setRuntimeVersion(profileRuntimeId(profile));
    setAcceptedMainRisk(false);
  }, [profile.active_revision]);
  const selectedMain = mainBuilds.find((build) => mainRuntimeId(build) === runtimeVersion);
  const {data:storage, refresh:refreshStorage} = useLocalResource<ProfileStorage>("profile_storage", {profileId:profile.id});
  return (
    <div className="profile-settings">
      <section className="setting-row">
        <div>
          <h3>Версия VoxelCore</h3>
          <p>{modpack ? `Определяется сборкой ${modpack.title || modpack.id} ${modpack.version}. Меняется вместе с версией сборки.` : profile.external_runtime ? "Используется VoxelCore из подключённой папки. Версия задаёт совместимость с контент-паками." : "Перед сменой лаунчер проверит совместимость всех выбранных контент-паков."}</p>
        </div>
        {modpack ? (
          <div className="profile-managed-value">
            <span>VoxelCore</span>
            <strong>{engineVersion(profile)}</strong>
            <small>Управляется сборкой</small>
          </div>
        ) : profile.external_runtime ? (
          <div className="profile-managed-value">
            <span>Локальный VoxelCore</span>
            <strong>{engineVersion(profile)}</strong>
            <small className="selectable" title={profile.external_runtime.path}>{profile.external_runtime.path}</small>
          </div>
        ) : <form
          className="actions"
          onSubmit={(event) => {
            event.preventDefault();
            changeRuntime(runtimeVersion);
          }}
        >
          <Select
            aria-label="Версия VoxelCore профиля"
            value={runtimeVersion}
            onChange={(event) => setRuntimeVersion(event.target.value)}
          >
            {!runtimeVersion && <option value="" disabled>Выберите версию</option>}
            {profile.main_build && !mainBuilds.some((build) => build.artifact_id === profile.main_build!.artifact_id) && (
              <option value={mainRuntimeId(profile.main_build)}>{mainBuildLabel(profile.main_build)} · текущая · не установлена</option>
            )}
            {mainBuilds.map((build) => (
              <option key={mainRuntimeId(build)} value={mainRuntimeId(build)} disabled={!mainlineStatus.enabled && build.artifact_id !== profile.main_build?.artifact_id}>
                {mainBuildLabel(build)} · экспериментальная
              </option>
            ))}
            {!!engineVersion(profile) && !profile.main_build && !availableRuntimes.some((item) => item.version === engineVersion(profile)) && (
              <option value={engineVersion(profile)}>{engineVersion(profile)} · текущая</option>
            )}
            {availableRuntimes.map((item) => (
              <option key={item.version} value={item.version}>
                {item.version} · {item.channel === "stable" ? "стабильная" : item.channel === "local" ? "локальная сборка" : item.channel}
              </option>
            ))}
          </Select>
          {selectedMain && runtimeVersion !== profileRuntimeId(profile) && <label className="checkbox-row">
            <input type="checkbox" checked={acceptedMainRisk} onChange={(event) => setAcceptedMainRisk(event.target.checked)} />
            Понимаю риск для модов и миров
          </label>}
          <button disabled={busy || !runtimeVersion || runtimeVersion === profileRuntimeId(profile) || (!!selectedMain && !acceptedMainRisk)}>
            Применить
          </button>
        </form>}
      </section>
      {profile.external_game_path && (
        <section className="setting-row">
          <div className="connected-folder-details">
            <h3>Подключённая папка</h3>
            <p className="selectable" title={profile.external_game_path}>{profile.external_game_path}</p>
            <small className={profile.problem === "Подключённая папка игры недоступна" ? "danger-text" : "muted"}>
              {profile.problem === "Подключённая папка игры недоступна" ? "Папка недоступна" : "Подключена напрямую · данные не копируются"}
            </small>
          </div>
          <div className="actions">
            <button
              disabled={busy || profile.problem === "Подключённая папка игры недоступна"}
              onClick={() => void run("Открытие папки", async () => invoke("open_profile_folder", { profileId: profile.id, section: "game" }))}
            >
              Открыть
            </button>
            <button
              disabled={busy}
              onClick={() => void (async () => {
                const path = await open({ directory: true, multiple: false, title: "Выберите папку игры" });
                if (typeof path !== "string") return;
                await run("Переподключение папки", async () => {
                  await invoke("reconnect_existing_game", { profileId: profile.id, path });
                  await refresh();
                });
              })()}
            >
              Изменить путь…
            </button>
          </div>
        </section>
      )}
      <section className="setting-row">
        <div>
          <h3>Место на диске</h3>
          <p>
            {storage
              ? profile.external_game_path
                ? `${formatBytes(storage.total_bytes)} занимает VLauncher. Подключённая папка: ${formatBytes(storage.game_bytes)}; эти данные остаются на своём месте.`
                : `${formatBytes(storage.total_bytes)}: миры и настройки ${formatBytes(storage.game_bytes)}, снимки ${formatBytes(storage.snapshot_bytes)}.`
              : "Подсчёт размера…"}
            {storage && storage.reclaimable_bytes > 0 && (
              <>
                <br />
                Можно освободить {formatBytes(storage.reclaimable_bytes)}, сохранив текущий снимок и откат.
              </>
            )}
          </p>
        </div>
        <button
          disabled={busy || !storage?.reclaimable_bytes}
          onClick={() =>
            void run("Очистка старых снимков", async () => {
              await invoke<ProfileStorage>("clean_profile_snapshots", {
                profileId: profile.id,
              });
              refreshStorage();
            })
          }
        >
          Очистить старые снимки
        </button>
      </section>
      <section className="setting-row">
        <div>
          <h3>Вернуть предыдущий снимок</h3>
          <p>
            Восстанавливает прошлые версии пакетов, VoxelCore и закрепления.
            Миры и настройки не откатываются.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            confirm({
              title: `Откатить «${profile.name}»?`,
              text: "Лаунчер переключит профиль на предыдущий сохранённый состав. Текущий снимок останется доступен для обратного отката.",
              label: "Вернуть предыдущий снимок",
              action: async () => {
                await invoke("rollback_profile", { profileId: profile.id });
                await refresh();
              },
            })
          }
        >
          Откатить…
        </button>
      </section>
      <section className="setting-row">
        <div>
          <h3>Иконка профиля</h3>
          <p>PNG, JPEG или WebP до 10 МБ. Изображение обрезается по центру до квадрата.</p>
          {profile.icon && <img className="profile-icon-preview" src={profile.icon} alt="Иконка профиля" />}
        </div>
        <div className="actions">
          <label className="file-button">Выбрать изображение
            <input type="file" disabled={busy} accept="image/png,image/jpeg,image/webp" onChange={event => {
              const file = event.target.files?.[0]; event.target.value = "";
              if (file) void run("Иконка профиля", async () => {
                await invoke("set_profile_icon", {profileId:profile.id,icon:await profileIcon(file)});
                await refresh();
              });
            }} />
          </label>
          <button disabled={busy || !profile.icon} onClick={() => void run("Сброс иконки", async () => {
            await invoke("set_profile_icon", {profileId:profile.id,icon:null}); await refresh();
          })}>Сбросить</button>
        </div>
      </section>
      <section className="setting-row">
        <div>
          <h3>Название профиля</h3>
          <p>Отображается только в лаунчере.</p>
        </div>
        <form
          className="actions"
          onSubmit={(e) => {
            e.preventDefault();
            void run("Переименование", async () => {
              await invoke("rename_profile", { profileId: profile.id, name });
              await refresh();
            });
          }}
        >
          <input
            aria-label="Название профиля"
            maxLength={80}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            disabled={busy || !name.trim() || name.trim() === profile.name}
          >
            Сохранить
          </button>
        </form>
      </section>
      <section className="setting-row">
        <div>
          <h3>Создать полную копию</h3>
          <p>
            Создаст отдельный профиль с теми же пакетами,
            <br />
            мирами и настройками игры.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void run("Копирование профиля", async () => {
              const p = await invoke<LocalProfile>("clone_profile", {
                profileId: profile.id,
                name: `${profile.name.slice(0, 70)} - копия`,
              });
              await refresh();
              select(p.id);
            })
          }
        >
          Создать копию
        </button>
      </section>
      <section className="setting-row">
        <div>
          <h3>Поделиться составом</h3>
          <p>
            Файл с версией игры и списком пакетов.
            <br />
            Миры в него не входят.
          </p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void run("Экспорт профиля", async () => {
              const path = await save({
                defaultPath: "profile.vlauncher.json",
                filters: [{ name: "Профиль VLauncher", extensions: ["json"] }],
              });
              if (path)
                await invoke("export_profile", { profileId: profile.id, path });
            })
          }
        >
          Экспортировать
        </button>
      </section>
      <section className="setting-row">
        <div>
          <h3>Удалить профиль</h3>
          <p>{profile.external_game_path ? "Отключит профиль от VLauncher. Сама папка игры и все её данные останутся на месте." : "Удалит его миры, настройки и установленные пакеты."}</p>
        </div>
        <button
          className="danger"
          disabled={busy}
          onClick={() =>
            confirm({
              title: `Удалить «${profile.name}»?`,
              text: profile.external_game_path
                ? "Профиль исчезнет из VLauncher, но подключённая папка, миры, настройки и контент удалены не будут."
                : "Все миры и настройки этого профиля будут удалены с компьютера. Восстановить их через лаунчер нельзя.",
              label: "Удалить профиль",
              danger: true,
              action: async () => {
                await invoke("delete_profile", { profileId: profile.id });
                await refresh();
              },
            })
          }
        >
          Удалить…
        </button>
      </section>
    </div>
  );
}
function Worlds({
  profile,
  folder,
  catalog,
  busy,
  run,
  publish,
}: {
  profile: LocalProfile;
  folder: () => void;
  catalog: () => void;
  busy: boolean;
  run: RunTask;
  publish: (folder: string) => void;
}) {
  const inspect = useContentInspector();
  const result = useLocalResource<
    {
      folder: string;
      name: string;
      modified: number;
      voxelcore_version?: string;
      compatible?: boolean;
      dependencies: string[];
      missing_dependencies: string[];
      preview_data?: string;
    }[]
>("list_worlds", {profileId:profile.id});
  const worlds = result.data ?? [];
  const {error,loading,refresh} = result;
  return (
    <>
      <div className="section-heading">
        <div>
          <h3>Миры профиля</h3>
        </div>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              void open({
                multiple: false,
                filters: [{ name: "Архив мира VoxelCore", extensions: ["zip"] }],
              }).then((path) => {
                if (!path) return;
                void run("Импорт мира", async () => {
                  await invoke("import_world", { profileId: profile.id, path });
                  refresh();
                });
              })
            }
          >
            Импортировать
          </button>
          <button onClick={refresh} disabled={loading}>
            Обновить
          </button>
          <button disabled={busy} onClick={folder}>
            <Icon name="folder" size={16} />
            Папка миров
          </button>
        </div>
      </div>
      {error && <ErrorNotice retry={refresh}>{error}</ErrorNotice>}
      {loading ? (
        <div className="loading">Читаем миры…</div>
      ) : worlds.length ? (
        <div className="content-list">
          {worlds.map((world) => (
            <div className="content-row" key={world.folder}>
              {world.preview_data ? (
                <img className="world-preview" src={world.preview_data} alt="" />
              ) : (
                <span className="package-symbol">
                  <Icon name="world" />
                </span>
              )}
              <div className="grow">
                <strong>{world.name}</strong>
                <small>
                  {world.folder}
                  {world.voxelcore_version && ` · VoxelCore ${world.voxelcore_version}`}
                  {world.compatible === false && " · требуется другая версия движка"}
                </small>
                {!!world.dependencies.length && (
                  <details className={`world-packages${world.missing_dependencies.length ? " has-missing" : ""}`}>
                    <summary>
                      Пакеты мира: {world.dependencies.length}
                      {world.missing_dependencies.length
                        ? ` · не установлено: ${world.missing_dependencies.length}`
                        : " · всё установлено"}
                    </summary>
                    <div className="world-package-list">
                      {world.dependencies.map((id) => {
                        const missing = world.missing_dependencies.includes(id);
                        if (missing) {
                          return <span className="world-package missing" key={id}><span>{id}</span><small>Не установлен</small></span>;
                        }
                        const external = profile.external_packages?.find(pkg => pkg.id === id);
                        return (
                          <span className="world-package" key={id}>
                            <button className="dependency-project-link" onClick={() => {
                              inspect(external ? { source: external.source, slug: external.slug, title: external.title, version: external.version, versionId: external.version_id, parent: world.name }
                                : { source: profile.manual_packages?.includes(id) ? "local" : "vspace", slug: id, version: profile.packages.find(pkg => pkg.id === id)?.version, parent: world.name });
                            }}>{id}</button>
                            <small>Установлен</small>
                          </span>
                        );
                      })}
                    </div>
                  </details>
                )}
              </div>
              <small>
                {world.modified
                  ? new Date(world.modified * 1000).toLocaleDateString("ru")
                  : "Дата неизвестна"}
              </small>
              <button
                disabled={busy}
                onClick={() =>
                  void save({
                    defaultPath: `${world.folder}.zip`,
                    filters: [{ name: "Архив мира VoxelCore", extensions: ["zip"] }],
                  }).then((path) => {
                    if (!path) return;
                    void run(`Экспорт мира · ${world.name}`, async () => {
                      await invoke("export_world", {
                        profileId: profile.id,
                        folder: world.folder,
                        path,
                      });
                    });
                  })
                }
              >
                Экспортировать
              </button>
              <button disabled={busy} onClick={() => publish(world.folder)}>
                Опубликовать…
              </button>
            </div>
          ))}
        </div>
      ) : (
        <Empty icon="world" title="Здесь будут ваши миры">
          <p>
            Нажмите «Играть» и создайте первый мир.
            <br />
            Готовые карты можно найти в каталоге.
          </p>
          <button onClick={catalog}>Найти карту</button>
        </Empty>
      )}
    </>
  );
}
function Activity({
  tasks,
  logs,
  profiles,
  clearLogs,
  clearTasks,
}: {
  tasks: Task[];
  logs: GameEvent[];
  profiles: LocalProfile[];
  clearLogs: () => void;
  clearTasks: () => void;
}) {
  const [tab, setTab] = useState("tasks");
  const [filter, setFilter] = useState("");
  const [exportError, setExportError] = useState("");
  const visible = logs.filter((log) => !filter || log.profile_id === filter);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Журнал</h1>
        </div>
        <div className="actions">
          <button
            disabled={tab === "tasks" ? !tasks.length : !logs.length}
            onClick={tab === "tasks" ? clearTasks : clearLogs}
          >
            {tab === "tasks" ? "Очистить операции" : "Очистить вывод"}
          </button>
          <button
          onClick={() =>
            void save({
              defaultPath: "vlauncher-diagnostics.json",
              filters: [{ name: "Диагностика VLauncher", extensions: ["json"] }],
            }).then(async (path) => {
              if (!path) return;
              try {
                await invoke("export_diagnostics", {
                  path,
                  contents: JSON.stringify(
                    {
                      created_at: new Date().toISOString(),
                      tasks,
                      game_output: logs,
                      profiles: profiles.map((item) => ({
                        id: item.id,
                        name: item.name,
                        voxelcore_version: item.voxelcore_version,
                        problem: item.problem,
                      })),
                    },
                    null,
                    2,
                  ),
                });
                setExportError("");
              } catch (error) {
                setExportError(String(error));
              }
            })
          }
        >
          Экспорт диагностики
          </button>
        </div>
      </header>
      {exportError && <ErrorNotice>{exportError}</ErrorNotice>}
      <div className="tab-bar">
        {[
          ["tasks", "Операции"],
          ["logs", "Вывод игры"],
        ].map(([id, title]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {title}
          </button>
        ))}
      </div>
      {tab === "tasks" ? (
        tasks.length ? (
          <div className="task-list">
            {tasks.map((task) => (
              <article key={task.id} className={task.status}>
                <span className="package-symbol">
                  <Icon
                    name={
                      task.status === "done"
                        ? "check"
                        : task.status === "error"
                          ? "close"
                          : "download"
                    }
                  />
                </span>
                <div className="grow">
                  <strong>{task.title}</strong>
                  <p>{task.detail}</p>
                </div>
                <small>{task.time}</small>
              </article>
            ))}
          </div>
        ) : (
          <Empty icon="activity" title="Пока всё спокойно">
            <p>Здесь появятся установки, обновления и ошибки.</p>
          </Empty>
        )
      ) : (
        <>
          <div className="section-heading">
            <label>
              Профиль
              <Select
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">Все профили</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </label>
          </div>
          {visible.length ? (
            <pre className="log-view">
              {visible
                .map(
                  (log) =>
                    `[${profiles.find((p) => p.id === log.profile_id)?.name ?? log.profile_id}] [${log.stream}] ${log.message}`,
                )
                .join("\n")}
            </pre>
          ) : (
            <Empty icon="terminal" title="Игра ещё ничего не записала">
              <p>После запуска здесь появится её вывод.</p>
            </Empty>
          )}
        </>
      )}
    </>
  );
}

function ProfileLogs({
  profile,
  logs,
  running,
  clear,
}: {
  profile: LocalProfile;
  logs: GameEvent[];
  running: boolean;
  clear: () => void;
}) {
  const output = useRef<HTMLPreElement>(null);
  useEffect(() => {
    output.current?.scrollTo({ top: output.current.scrollHeight });
  }, [logs]);
  return (
    <div className="profile-logs">
      <div className="section-heading">
        <div>
          <h3>Вывод VoxelCore</h3>
          <p>
            {running
              ? "Игра запущена - новые строки появляются здесь автоматически."
              : "Вывод последнего запуска в этом сеансе лаунчера."}
          </p>
        </div>
        <div className="actions">
          {running && <span className="live-indicator"><i />В реальном времени</span>}
          <button disabled={!logs.length} onClick={clear}>Очистить</button>
        </div>
      </div>
      {logs.length ? (
        <pre ref={output} className="log-view profile-log-view">
          {logs.map((log) => `[${log.stream}] ${log.message}`).join("\n")}
        </pre>
      ) : (
        <Empty icon="terminal" title={`Пока нет вывода · ${profile.name}`}>
          <p>После запуска игры сообщения появятся здесь автоматически.</p>
        </Empty>
      )}
    </div>
  );
}
