import type { LocalProfile } from "./model";

export function contentAddition(
  profile: Pick<LocalProfile, "roots" | "root_requirements"> | undefined,
  packageId: string,
  release: { version: string; channel: string },
) {
  return {
    roots: [...new Set([...(profile?.roots ?? []), packageId])],
    requirements: {
      ...profile?.root_requirements,
      [packageId]: `=${release.version}`,
    },
    channels:
      release.channel === "stable" ? ["stable"] : ["stable", release.channel],
  };
}

export async function prepareContentAddition(
  profile: LocalProfile | undefined,
  packageId: string,
  release: { version: string; channel: string },
  loadReleases: (id: string) => Promise<{ version: string; channel: string }[]>,
) {
  const request = contentAddition(profile, packageId, release);
  const installed = (profile?.packages ?? []).filter(
    (pkg) =>
      pkg.id !== packageId &&
      pkg.kind !== "runtime" &&
      !pkg.id.startsWith("__world_"),
  );
  const channels = new Set(request.channels);
  for (let start = 0; start < installed.length; start += 4) {
    const found = await Promise.all(
      installed
        .slice(start, start + 4)
        .map(
          async (pkg) =>
            (await loadReleases(pkg.id)).find((r) => r.version === pkg.version)
              ?.channel,
        ),
    );
    for (const channel of found) if (channel) channels.add(channel);
  }
  return { ...request, channels: [...channels] };
}
