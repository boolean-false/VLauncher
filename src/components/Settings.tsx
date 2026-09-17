import { AnalyticsDetails } from "./AnalyticsConsent";
import { readConsent, setAnalyticsConsent } from "../telemetry";
import { useLocalResource } from "../useLocalResource";
import { Select } from "./Select";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import type { Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { formatBytes, type RunTask, type Runtime } from "../model";
import { registryUrl, type RuntimeRelease } from "../api";
import { ErrorNotice, Icon } from "./ui";
import { ThemeSettings } from "./ThemeSettings";
import { MainlineSettings } from "./Mainline";
import { mainBuildLabel, type MainBuild } from "../model";
import { checkForAppUpdate, type AppUpdateChannel } from "../appUpdates";
import { useVoxelCoreVersionLabel } from "../VoxelCoreVersionContext";
import {
  setJointCatalogEnabled,
  useJointCatalogEnabled,
} from "../experimental";
type Cache = {
  artifacts: number;
  artifact_bytes: number;
  partial_downloads: number;
  partial_bytes: number;
};
export function Settings({
  gameRunning,
  updateChannel,
  setUpdateChannel,
  discordEnabled, setDiscordEnabled,
  runtimes,
  availableRuntimes,
  runtimeCatalogError,
  reloadRuntimes,
  usedVersions,
  busy,
  run,
  install,
  installMainline,
  remove,
  refresh,
}: {
  gameRunning: boolean;
  updateChannel: AppUpdateChannel;
  setUpdateChannel: (channel: AppUpdateChannel) => void;
  discordEnabled: boolean;
  setDiscordEnabled: (value: boolean) => void;
  runtimes: Runtime[];
  availableRuntimes: RuntimeRelease[];
  runtimeCatalogError: string;
  reloadRuntimes: () => void;
  usedVersions: Set<string>;
  busy: boolean;
  run: RunTask;
  install: (version: string) => Promise<void>;
  installMainline: (build: MainBuild) => Promise<boolean>;
  remove: (version: string) => void;
  refresh: () => Promise<void>;
}) {
  const versionLabel = useVoxelCoreVersionLabel();
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [versionError, setVersionError] = useState(false);
  useEffect(() => {
    let active = true;
    void getVersion()
      .then((version) => { if (active) setAppVersion(version); })
      .catch(() => { if (active) setVersionError(true); });
    return () => { active = false; };
  }, []);
  const [analytics, setAnalytics] = useState(readConsent);
  useEffect(() => { const changed = () => setAnalytics(readConsent()); window.addEventListener("analytics-consent-changed", changed); return () => window.removeEventListener("analytics-consent-changed", changed); }, []);
  const [analyticsError, setAnalyticsError] = useState("");
  const jointCatalogEnabled = useJointCatalogEnabled();
  const [settingsTab, setSettingsTab] = useState<"app" | "appearance" | "storage" | "experimental">(() => { const value = sessionStorage.getItem("vlauncher.settings-tab"); return value === "storage" || value === "appearance" || value === "experimental" ? value : "app"; });
  useEffect(() => sessionStorage.setItem("vlauncher.settings-tab", settingsTab), [settingsTab]);
  const [discord, setDiscord] = useState<{ configured: boolean; state: string } | null>(null);
  useEffect(() => {
    const check = () => void invoke<{ configured: boolean; state: string }>("discord_presence_status").then(setDiscord).catch(() => setDiscord(null));
    check(); const timer = setInterval(check, 3000); return () => clearInterval(timer);
  }, []);
  const [selectedVersion, setSelectedVersion] = useState("");
  const selectedRelease = availableRuntimes.find((item) => item.version === selectedVersion) ?? availableRuntimes.find((item) => item.channel === "stable") ?? availableRuntimes[0];
  const { data: cache, refresh: refreshCache, error: cacheError } = useLocalResource<Cache>("cache_status", {}, 30_000, settingsTab === "storage");

  const [update, setUpdate] = useState<Update | null>(null);
  const [message, setMessage] = useState("");
  const { data: library, error: libraryError } = useLocalResource<string>("library_location", {}, 30_000, settingsTab === "storage");
  useEffect(() => {
    setMessage("");
    setUpdate((current) => {
      void current?.close().catch(() => { });
      return null;
    });
  }, [updateChannel]);
  useEffect(() => () => {
    void update?.close().catch(() => { });
  }, [update]);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Настройки</h1>
          <p>{settingsTab === "app" ? "Поведение приложения" : settingsTab === "appearance" ? "Темы и цвета интерфейса" : settingsTab === "experimental" ? "Нестабильные возможности для опытных пользователей" : "Файлы, кэш и версии VoxelCore"}</p>
        </div>
      </header>
      {(cacheError || libraryError) && <ErrorNotice>{cacheError || libraryError}</ErrorNotice>}
      <div className="settings-tabs" role="tablist" aria-label="Разделы настроек">
        <button role="tab" aria-selected={settingsTab === "app"} className={settingsTab === "app" ? "active" : ""} onClick={() => setSettingsTab("app")}>Приложение</button>
        <button role="tab" aria-selected={settingsTab === "appearance"} className={settingsTab === "appearance" ? "active" : ""} onClick={() => setSettingsTab("appearance")}>Оформление</button>
        <button role="tab" aria-selected={settingsTab === "storage"} className={settingsTab === "storage" ? "active" : ""} onClick={() => setSettingsTab("storage")}>Хранилище</button>
        <button role="tab" aria-selected={settingsTab === "experimental"} className={settingsTab === "experimental" ? "active" : ""} onClick={() => setSettingsTab("experimental")}>Экспериментальное</button>
      </div>
      <div className="settings-page">
        {settingsTab === "appearance" && <ThemeSettings />}
        {settingsTab === "experimental" && <div role="tabpanel" className="settings-tab-panel">
          <h2>Каталог</h2>
          <section className="setting-row">
            <div>
              <h3>Совместный каталог VoxelWorld</h3>
              <p>Добавляет моды VoxelWorld в поиск, объединяет категории площадок и позволяет устанавливать их в профиль.</p>
            </div>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={jointCatalogEnabled}
                onChange={(event) => setJointCatalogEnabled(event.target.checked)}
              />
              Включить
            </label>
          </section>
          <MainlineSettings busy={busy} install={installMainline} runtimes={runtimes} />
        </div>}
        {settingsTab === "app" && <div role="tabpanel" className="settings-tab-panel">
          <h2>Приложение</h2>
          <section className="setting-row">
            <div><h3>Статистика использования</h3><p>Помогает учитывать новые установки и возвращения в VLauncher.</p><AnalyticsDetails />{analyticsError && <ErrorNotice>{analyticsError}</ErrorNotice>}</div>
            <label className="checkbox-row analytics-consent-toggle"><input type="checkbox" checked={analytics} onChange={e => { try { setAnalyticsConsent(e.target.checked); setAnalytics(e.target.checked); setAnalyticsError(""); } catch { setAnalyticsError("Не удалось сохранить настройку. Попробуйте ещё раз."); } }} />Отправлять статистику</label>
          </section>
          <section className="setting-row">
            <div><h3>Discord</h3><p>Показывать, что вы в VLauncher или играете в VoxelCore.</p>
              <p>{!discordEnabled ? "Отключено" : !discord ? "Проверяем подключение…" : !discord.configured ? "Интеграция ещё не настроена в этой сборке." : discord.state === "connected" ? "Статус передан в Discord" : "Ожидаем Discord на этом компьютере. В Discord должен быть разрешён показ игровой активности."}</p>
            </div>
            <label className="checkbox-row"><input type="checkbox" checked={discordEnabled} onChange={e => setDiscordEnabled(e.target.checked)} />Показывать активность</label>
          </section>
          <section className="setting-row vlauncher-settings">
            <div className="vlauncher-about">
              <h3>VLauncher</h3>
              <p className="selectable">
                {appVersion ? `Версия ${appVersion}` : versionError ? "Не удалось определить версию" : "Определяем версию…"}
              </p>
              <p>Copyright © 2026 DaggerLab.</p>
              <button
                onClick={() => void openUrl("https://github.com/boolean-false/VLauncher")}
              >
                Исходный код
              </button>
              {import.meta.env.DEV && <p>Режим разработки. Обновление через исходники проекта.</p>}
            </div>
            {!import.meta.env.DEV && <div className="vlauncher-update">
              <div className="vlauncher-update-controls">
                <label className="update-channel-control">
                  <span>Канал обновлений</span>
                  <Select
                    value={updateChannel}
                    disabled={busy}
                    onChange={(event) => setUpdateChannel(event.target.value as AppUpdateChannel)}
                  >
                    <option value="stable">Стабильный</option>
                    <option value="beta">Бета и стабильные</option>
                  </Select>
                </label>
                <button
                  disabled={busy || gameRunning}
                  onClick={() =>
                    void run("Обновление VLauncher", async (stage) => {
                      if (update) {
                        await update.download((event) => {
                          if (event.event === "Progress")
                            stage("Загрузка обновления…");
                        });
                        if (gameRunning) throw new Error("Завершите игру перед обновлением");
                        await update.install();
                        await relaunch();
                      } else {
                        const available = await checkForAppUpdate(updateChannel);
                        setUpdate(available);
                        setMessage(
                          available
                            ? `Доступна версия ${available.version}`
                            : "Новых версий нет",
                        );
                      }
                    })
                  }
                >
                  {update ? "Установить и перезапустить" : "Проверить обновления"}
                </button>
              </div>
              <p className="vlauncher-update-status" role="status">
                {message || "Проверка новой версии приложения."}
              </p>
            </div>}
          </section>
          {import.meta.env.DEV && (
            <details className="developer-settings">
              <summary>Инструменты разработчика</summary>
              <section className="setting-row">
                <div>
                  <h3>API каталога</h3>
                  <p className="selectable">{registryUrl}</p>
                  <p>Адрес виден только в dev-сборке.</p>
                </div>
              </section>
            </details>
          )}
        </div>}
        {settingsTab === "storage" && <div role="tabpanel" className="settings-tab-panel">
          <h2>Хранилище</h2>
          <section className="setting-row">
            <div>
              <h3>Библиотека профилей</h3>
              <p className="selectable">{library || "Определяем расположение…"}</p>
              <p>Переносятся профили, миры, версии VoxelCore и кэш. Игры должны быть закрыты.</p>
            </div>
            <button
              disabled={busy}
              onClick={() => void run("Перенос библиотеки", async () => {
                const parent = await open({ directory: true, multiple: false });
                if (!parent) return;
                await invoke<string>("move_library", { parent });
                await refresh();
              })}
            >
              Перенести…
            </button>
          </section>
          <section className="setting-row">
            <div>
              <h3>
                Кэш загрузок{" "}
                {cache && (
                  <span className="muted">
                    · {formatBytes(cache.artifact_bytes + cache.partial_bytes)}
                  </span>
                )}
              </h3>
              <p>
                Архивы для повторной установки. Очистка не удаляет игры и миры.
              </p>
              {cache && (
                <small>
                  {cache.artifacts} архивов · {cache.partial_downloads}{" "}
                  незавершённых загрузок
                </small>
              )}
            </div>
            <button
              disabled={
                busy || !cache || cache.artifacts + cache.partial_downloads === 0
              }
              onClick={() =>
                void run("Очистка кэша", async () =>
                  (await invoke<Cache>("clear_cache"), refreshCache()),
                )
              }
            >
              Очистить кэш
            </button>
          </section>
          <div className="section-heading">
            <div>
              <h2>Версии VoxelCore · GitHub</h2>
              <p>Официальные релизы VoxelCore для вашей системы.</p>
            </div>
            <button onClick={reloadRuntimes} disabled={busy}>Обновить список</button>
          </div>

          {runtimeCatalogError && (
            <ErrorNotice retry={reloadRuntimes}>Не удалось загрузить релизы VoxelCore с GitHub.</ErrorNotice>
          )}
          {!!availableRuntimes.length && (
            <label>
              Версия для установки
              <Select value={selectedRelease?.version ?? ""} onChange={(event) => setSelectedVersion(event.target.value)}>
                {availableRuntimes.map((release) => (
                  <option key={release.version} value={release.version}>
                    {release.version} · {release.channel === "stable" ? "стабильная" : release.channel}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {(selectedRelease ? [selectedRelease] : []).map((release) => {
            const installed = runtimes.some((runtime) => runtime.version === release.version);
            return (
              <section className="setting-row" key={`available-${release.version}`}>
                <div>
                  <h3>VoxelCore {release.version}</h3>
                  <p>
                    {release.channel === "stable" ? "Стабильная версия" : release.channel} ·{" "}
                    {formatBytes(release.artifact_size)}
                  </p>
                </div>
                <div className="actions">
                  <button disabled={busy} onClick={() => void install(release.version)}>
                    {installed ? "Переустановить" : "Установить"}
                  </button>
                  {installed && (
                    <button
                      className="danger"
                      disabled={busy || usedVersions.has(release.version)}
                      title={usedVersions.has(release.version) ? "Версия используется профилем" : ""}
                      onClick={() => remove(release.version)}
                    >
                      Удалить
                    </button>
                  )}
                </div>
              </section>
            );
          })}
          <h2 className="installed-runtimes-heading">На компьютере</h2>
          {runtimes.length ? (
            runtimes
              .map((r) => (
                <section className="setting-row" key={`${r.version}-${r.platform}`}>
                  <div>
                    <h3>
                      <Icon name="package" size={16} />
                      VoxelCore {r.main_build ? mainBuildLabel(r.main_build) : versionLabel(r.version)}
                    </h3>
                    <p className="selectable">{r.path}</p>
                  </div>
                  <button disabled={busy || usedVersions.has(r.version)} onClick={() => remove(r.version)}
                    title={usedVersions.has(r.version) ? "Версия используется профилем" : ""}>Удалить</button>
                </section>
              ))
          ) : (
            <p className="muted">
              Игра будет загружена при первом запуске профиля.
            </p>
          )}
          <details className="local-runtime-import">
            <summary>Добавить локальную версию VoxelCore</summary>
            <p>Только движок, без профиля, миров и контента. Подготовленная папка с runtime.json будет скопирована в хранилище VLauncher.</p>
            <button
              disabled={busy}
              onClick={() =>
                void run("Импорт локального VoxelCore", async () => {
                  const path = await open({ directory: true, multiple: false });
                  if (!path) return;
                  await invoke("import_runtime", { path });
                  await refresh();
                })
              }
            >
              Добавить среду VoxelCore…
            </button>
          </details>
        </div>}
      </div>
    </>
  );
}
