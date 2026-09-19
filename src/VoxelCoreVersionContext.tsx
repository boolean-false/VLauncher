import { createContext, useContext, useMemo, type ReactNode } from "react";
import { voxelCoreVersionLabel } from "./model";

const LatestPublishedVoxelCoreVersion = createContext("");

export function VoxelCoreVersionProvider({
  latestVersion,
  children,
}: {
  latestVersion: string;
  children: ReactNode;
}) {
  return (
    <LatestPublishedVoxelCoreVersion.Provider value={latestVersion}>
      {children}
    </LatestPublishedVoxelCoreVersion.Provider>
  );
}

export function useVoxelCoreVersionLabel() {
  const latestVersion = useContext(LatestPublishedVoxelCoreVersion);
  return useMemo(
    () => (version: string) => voxelCoreVersionLabel(version, latestVersion),
    [latestVersion],
  );
}

export function useLatestPublishedVoxelCoreVersion() {
  return useContext(LatestPublishedVoxelCoreVersion);
}
