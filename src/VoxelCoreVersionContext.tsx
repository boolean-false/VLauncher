import { createContext, useContext, useMemo, type ReactNode } from "react";
import { voxelCoreVersionLabel } from "./model";

const VoxelCoreVersions = createContext({ latestVersion: "", versions: [] as string[] });

export function VoxelCoreVersionProvider({
  latestVersion,
  versions = [],
  children,
}: {
  latestVersion: string;
  versions?: string[];
  children: ReactNode;
}) {
  return (
    <VoxelCoreVersions.Provider value={{ latestVersion, versions }}>
      {children}
    </VoxelCoreVersions.Provider>
  );
}

export function useVoxelCoreVersionLabel() {
  const { latestVersion } = useContext(VoxelCoreVersions);
  return useMemo(
    () => (version: string) => voxelCoreVersionLabel(version, latestVersion),
    [latestVersion],
  );
}

export function useLatestPublishedVoxelCoreVersion() {
  return useContext(VoxelCoreVersions).latestVersion;
}

export function usePublishedVoxelCoreVersions() {
  return useContext(VoxelCoreVersions).versions;
}
