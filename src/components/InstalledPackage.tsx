import { useRegistryResource } from "../useResource";
import { PrivateImage } from "./PrivateImage";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, type ReactNode } from "react";
import { type ProjectDetail } from "../api";
import { type LocalProfile } from "../model";
import { useJointCatalogEnabled } from "../experimental";
import { useVoxelWorldMod } from "../voxelWorld";
import { Icon, type IconName } from "./ui";

export function InstalledPackage({
  pkg,
  profileId,
  root,
  open,
}: {
  pkg: LocalProfile["packages"][number];
  profileId: string;
  root: boolean;
  open: () => void;
}) {
  const { data: project, loading } = useRegistryResource<ProjectDetail>(
    `/projects/${encodeURIComponent(pkg.id)}`,
  );
  const image = project?.cover_url || project?.latest_release?.preview_url;
  const title = project?.title || pkg.title || pkg.id;
  return (
    <button
      className="installed-package"
      onClick={open}
      aria-label={`Открыть карточку ${title}`}
    >
      <span className="package-symbol">
        <InstalledContentIcon
          profileId={profileId}
          packageId={pkg.id}
          serverUrl={image || undefined}
        />
      </span>
      <span className="installed-package-copy">
        <strong title={pkg.id}>{title}</strong>
        <span className="installed-package-summary">
          {project?.summary ||
            (loading
              ? "Загружаем описание…"
              : project
                ? "Описание пока не добавлено"
                : "Описание недоступно - можно повторить в карточке")}
        </span>
        <small>
          {root ? "Выбран вами" : "Зависимость · установлена автоматически"}
        </small>
      </span>
    </button>
  );
}

export function InstalledVoxelWorldIcon({
  profileId,
  packageId,
  slug,
}: {
  profileId: string;
  packageId: string;
  slug: string;
}) {
  const enabled = useJointCatalogEnabled();
  const project = useVoxelWorldMod(slug, enabled).data;
  return (
    <InstalledContentIcon
      profileId={profileId}
      packageId={packageId}
      serverUrl={project?.logo_url || undefined}
      externalServer
    />
  );
}

export function InstalledContentIcon({
  profileId,
  packageId,
  serverUrl,
  externalServer = false,
  fallbackIcon = "package",
}: {
  profileId: string;
  packageId: string;
  serverUrl?: string;
  externalServer?: boolean;
  fallbackIcon?: IconName;
}) {
  const key = `${profileId}:${packageId}`;
  const [local, setLocal] = useState<{
    key: string;
    url?: string;
    loading: boolean;
    failed: boolean;
  }>({ key, loading: true, failed: false });
  useEffect(() => {
    let alive = true;
    let sequence = 0;
    const load = () => {
      const request = ++sequence;
      setLocal((old) => ({
        key,
        url: old.key === key ? old.url : undefined,
        loading: true,
        failed: false,
      }));
      void invoke<string | null>("read_content_icon", {
        profileId,
        packageId,
      }).then(
        (url) => {
          if (alive && request === sequence)
            setLocal({
              key,
              url: url || undefined,
              loading: false,
              failed: false,
            });
        },
        () => {
          if (alive && request === sequence)
            setLocal({ key, loading: false, failed: false });
        },
      );
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.removeEventListener("focus", load);
    };
  }, [key, packageId, profileId]);
  const current =
    local.key === key ? local : { key, loading: true, failed: false };
  const fallback = <Icon name={fallbackIcon} />;
  if (current.url && !current.failed)
    return (
      <img
        src={current.url}
        alt=""
        onError={() => setLocal((old) => ({ ...old, failed: true }))}
      />
    );
  if (current.loading) return fallback;
  if (!serverUrl) return fallback;
  return externalServer ? (
    <ExternalImage src={serverUrl} fallback={fallback} />
  ) : (
    <PrivateImage src={serverUrl} alt="" fallback={fallback} />
  );
}

function ExternalImage({
  src,
  fallback,
}: {
  src: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? (
    fallback
  ) : (
    <img src={src} alt="" onError={() => setFailed(true)} />
  );
}
