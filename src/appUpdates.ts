import { check, type Update } from "@tauri-apps/plugin-updater";

export type AppUpdateChannel = "stable" | "beta";

export const appUpdateChannelKey = "vlauncher.update-channel";

export const loadAppUpdateChannel = (): AppUpdateChannel =>
  localStorage.getItem(appUpdateChannelKey) === "beta" ? "beta" : "stable";

export const checkForAppUpdate = (channel: AppUpdateChannel): Promise<Update | null> =>
  check({
    headers: { "X-VLauncher-Channel": channel },
    timeout: 30_000,
  });
