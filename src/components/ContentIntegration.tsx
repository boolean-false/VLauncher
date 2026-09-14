import { type ReactNode, useMemo } from "react";
import { useJointCatalogEnabled } from "../experimental";
import { vspaceContentSource, type ContentSource } from "../contentView";
import { voxelWorldContentSource } from "../voxelWorldContentSource";
import { ContentInspectorProvider } from "./ContentInspector";

// Optional sources are registered only here; the inspector does not import integrations.
export function ContentIntegration({ children }: { children: ReactNode }) {
  const enabled = useJointCatalogEnabled();
  const sources = useMemo<Record<string, ContentSource>>(
    () => ({
      vspace: vspaceContentSource,
      ...(enabled ? { voxelworld: voxelWorldContentSource } : {}),
    }),
    [enabled],
  );
  return (
    <ContentInspectorProvider sources={sources}>
      {children}
    </ContentInspectorProvider>
  );
}
