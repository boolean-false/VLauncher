import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  type ContentRef,
  type ContentInfo,
  type ContentSource,
} from "../contentView";
import { Modal, ErrorNotice, Icon } from "./ui";
import { Markdown } from "./Markdown";
import { Select } from "./Select";
import { contentIdentity as identity, visitContent } from "../contentHistory";
import { PrivateImage } from "./PrivateImage";

type Inspect = (ref: ContentRef) => void;
const InspectorContext = createContext<Inspect>(() => {});
export const useContentInspector = () => useContext(InspectorContext);
const NavigationContext = createContext<
  (action: ((ref: ContentRef) => void) | null) => void
>(() => {});
export const useInspectorNavigation = () => useContext(NavigationContext);
const relationLabel: Record<string, string> = {
  required: "Обязательная зависимость",
  optional: "Необязательная связь",
  weak: "Связь порядка загрузки",
  conflict: "Конфликт",
};

export function ContentInspectorProvider({
  sources,
  children,
}: {
  sources: Record<string, ContentSource>;
  children: ReactNode;
}) {
  const [history, setHistory] = useState<ContentRef[]>([]);
  const navigate = useRef<((ref: ContentRef) => void) | null>(null);
  const register = useRef((action: ((ref: ContentRef) => void) | null) => {
    navigate.current = action;
  }).current;
  const push = (ref: ContentRef) => setHistory((old) => visitContent(old, ref));
  return (
    <NavigationContext.Provider value={register}>
      <InspectorContext.Provider value={(ref) => setHistory([ref])}>
        {children}
        {history.length > 0 && (
          <Modal title="Просмотр контента" close={() => setHistory([])}>
            <nav
              className="content-inspector-history"
              aria-label="История просмотра"
            >
              <button
                disabled={history.length < 2}
                onClick={() => setHistory((old) => old.slice(0, -1))}
              >
                ← Назад
              </button>
              <span>
                {history.map((ref) => ref.title || ref.slug).join(" → ")}
              </span>
            </nav>
            {history.map((ref, index) => (
              <InspectorEntry
                key={identity(ref)}
                target={ref}
                source={sources[ref.source]}
                hidden={index !== history.length - 1}
                open={push}
              />
            ))}
            <div className="modal-actions">
              <button onClick={() => setHistory([])}>Закрыть просмотр</button>
              {sources[history[history.length - 1].source] && (
                <button
                  onClick={() => {
                    navigate.current?.(history[history.length - 1]);
                    setHistory([]);
                  }}
                >
                  Открыть полную страницу
                </button>
              )}
            </div>
          </Modal>
        )}
      </InspectorContext.Provider>
    </NavigationContext.Provider>
  );
}

function InspectorEntry({
  target,
  source,
  hidden,
  open,
}: {
  target: ContentRef;
  source?: ContentSource;
  hidden: boolean;
  open: Inspect;
}) {
  const [data, setData] = useState<ContentInfo>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [version, setVersion] = useState<string>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let alive = true;
    setData(undefined);
    setError("");
    if (source)
      void source.load(version ? { ...target, version } : target).then(
        (value) => {
          if (alive) setData(value);
        },
        (reason) => {
          if (alive) setError(String(reason));
        },
      );
    return () => {
      alive = false;
    };
  }, [source, target, retry, version]);
  useEffect(() => {
    if (!hidden) heading.current?.focus({ preventScroll: true });
  }, [hidden]);
  return (
    <section hidden={hidden}>
      <div className="content-inspector-heading">
        <ContentIcon data={data} source={target.source} />
        <div>
          <h2 ref={heading} tabIndex={-1}>
            {data?.title || target.title || target.slug}
          </h2>
          <p className="muted">
            {source?.label || target.source} ·{" "}
            {version ||
              target.version ||
              data?.version ||
              target.requirement ||
              "Версия не выбрана"}
          </p>
        </div>
      </div>
      {target.requirement && (
        <p className="muted">
          Требование родительского пакета: {target.requirement}
        </p>
      )}
      {target.parent && (
        <p>
          {target.relation
            ? `${relationLabel[target.relation] || "Связь"} для`
            : "Открыто из"}{" "}
          «{target.parent}».
        </p>
      )}
      <div className="content-inspector-body">
        {!source ? (
          <p className="notice">
            {target.source === "local"
              ? "Локальный пакет. Он добавлен вручную и не связан с опубликованным проектом каталога."
              : "Источник недоступен или выключен. Сведения о пакете сохранены выше."}
          </p>
        ) : error ? (
          <ErrorNotice retry={() => setRetry((value) => value + 1)}>
            {error}
          </ErrorNotice>
        ) : !data ? (
          <p role="status">Загружаем описание и зависимости…</p>
        ) : (
          <>
            {data.note && <p className="notice">{data.note}</p>}
            {!target.version &&
              !target.versionId &&
              !!data.versions?.length && (
                <label>
                  Версия для просмотра
                  <Select
                    value={version || data.version || ""}
                    onChange={(event) => setVersion(event.target.value)}
                  >
                    <option value="" disabled>
                      Выберите версию
                    </option>
                    {data.versions.map((item) => (
                      <option value={item} key={item}>
                        {item}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
            <Markdown text={data.description || "Автор не добавил описание."} />
            <h3>Зависимости выбранной версии</h3>
            {!data.dependencies.length && (
              <p className="muted">
                {data.version
                  ? "Зависимости не указаны."
                  : "Нет данных для точной версии."}
              </p>
            )}
            {data.dependencies.map((dep) => (
              <button
                className="inspector-dependency"
                key={identity(dep)}
                onClick={() => open(dep)}
              >
                <strong>{dep.title || dep.slug}</strong>
                <span>{dep.version || dep.requirement}</span>
                <small>{relationLabel[dep.relation || "required"]}</small>
              </button>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function ContentIcon({ data, source }: { data?: ContentInfo; source: string }) {
  const fallback = (
    <span className={`project-icon ${data?.type || ""}`}>
      <Icon name={data?.type === "world" ? "world" : "package"} size={26} />
    </span>
  );
  if (!data?.iconUrl) return fallback;
  if (source === "vspace")
    return (
      <PrivateImage
        className="project-icon"
        src={data.iconUrl}
        alt=""
        fallback={fallback}
      />
    );
  return <ExternalContentIcon src={data.iconUrl} fallback={fallback} />;
}

function ExternalContentIcon({
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
    <img
      className="project-icon"
      src={src}
      alt=""
      onError={() => setFailed(true)}
    />
  );
}
