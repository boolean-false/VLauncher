import { compareSemVer } from "./model.ts";

export function updateReleaseNotes<
  T extends { version: string; channel: string },
>(releases: T[], installed: string, target: string): T[] {
  const targetRelease = releases.find((release) => release.version === target);
  return releases
    .filter(
      (release) =>
        compareSemVer(release.version, installed) > 0 &&
        compareSemVer(release.version, target) <= 0 &&
        (release.channel === "stable" ||
          release.channel === targetRelease?.channel),
    )
    .sort((a, b) => compareSemVer(b.version, a.version));
}
