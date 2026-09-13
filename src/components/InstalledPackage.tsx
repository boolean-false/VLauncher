import { useRegistryResource } from "../useResource";
import { PrivateImage } from "./PrivateImage";
import { type ProjectDetail } from "../api";
import { type LocalProfile } from "../model";
import { Icon } from "./ui";

export function InstalledPackage({
  pkg,
  root,
  open,
}: {
  pkg: LocalProfile["packages"][number];
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
        {image ? (
          <PrivateImage src={image} alt="" fallback={<Icon name="package" />} />
        ) : (
          <Icon name="package" />
        )}
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
