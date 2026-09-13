import { useEffect, useRef, useState } from "react";
type Data = {
  total: number;
  daily: { day: string; downloads: number }[];
  breakdown: {
    version: string;
    os: string;
    source: string;
    kind: string;
    count: number;
  }[];
  events: { day: string; kind: string; count: number }[];
  started_at: string;
};
const kinds: Record<string, string> = {
  download: "Скачивания",
  install: "Установки",
  view: "Просмотры",
};
const sources: Record<string, string> = {
  launcher: "VLauncher",
  vspace: "VSpace",
  direct: "Прямая ссылка",
  unknown: "Неизвестно",
};
export function ContentAnalytics({
  slug,
  request,
}: {
  slug: string;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
}) {
  const [days, setDays] = useState(30);
  const [kind, setKind] = useState("download");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const loadedAt = useRef(0);
  useEffect(() => {
    const focus = () => {
      if (!document.hidden && Date.now() - loadedAt.current > 60_000)
        setRevision((n) => n + 1);
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, []);
  useEffect(() => {
    setData(null);
  }, [slug, days]);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    void request<Data>(
      `/creator/projects/${encodeURIComponent(slug)}/analytics?days=${days}`,
      { cache: "no-store" },
    )
      .then((d) => {
        if (live) {
          setData(d);
          loadedAt.current = Date.now();
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [slug, days, revision]);
  const daily =
    data?.daily.map((d) => ({
      day: d.day,
      count:
        kind === "download"
          ? d.downloads
          : (data.events?.find((e) => e.day === d.day && e.kind === kind)
              ?.count ?? 0),
    })) ?? [];
  const maximum = Math.max(1, ...daily.map((d) => d.count));
  return (
    <section className="team-settings">
      <div className="section-heading">
        <h2>Статистика проекта</h2>
        <button disabled={busy} onClick={() => setRevision((n) => n + 1)}>
          {busy ? "Обновляем…" : "Обновить"}
        </button>
      </div>
      <div className="analytics-controls">
        <label>
          Период
          <select
            aria-label="Период"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {[7, 30, 90].map((n) => (
              <option key={n} value={n}>
                {n} дней
              </option>
            ))}
          </select>
        </label>
        <label>
          Показатель
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(kinds).map(([id, name]) => (
              <option value={id} key={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p className="error-notice" role="alert">
          {error}{" "}
          <button disabled={busy} onClick={() => setRevision((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}
      {!data && busy && <p role="status">Загрузка статистики…</p>}
      {data && (
        <>
          <p>
            Скачивания - полные передачи архива сервером; это не подтверждение
            получения файла игроком. Повторы из одной сети за сутки
            объединяются. Установки и просмотры в лаунчере учитываются только у
            участников добровольной статистики, включая установки из кэша.
            Просмотры сайта считаются без привязки к аккаунту. Это не число
            игроков.
          </p>
          <p>
            Новые показатели собираются с{" "}
            {new Date(data.started_at).toLocaleDateString("ru")}. Более ранние
            скачивания считались по началу запроса. Даты - UTC.
          </p>
          <div className="workshop-stats">
            <div>
              <strong>
                {daily.reduce((n, d) => n + d.count, 0).toLocaleString("ru")}
              </strong>
              <span>
                {kinds[kind]} за {days} дней
              </span>
            </div>
            <div>
              <strong>{daily[daily.length - 1]?.count ?? 0}</strong>
              <span>Сегодня</span>
            </div>
            <div>
              <strong>{data.total.toLocaleString("ru")}</strong>
              <span>Скачивания за всё время</span>
            </div>
          </div>
          <div
            className="analytics-chart"
            role="img"
            aria-label={`${kinds[kind]} по дням`}
          >
            {daily.map((d) => (
              <div key={d.day} title={`${d.day}: ${d.count}`}>
                <span style={{ height: `${(d.count / maximum) * 150}px` }} />
              </div>
            ))}
          </div>
          {!daily.some((d) => d.count > 0) && (
            <p>За выбранный период данных пока нет.</p>
          )}
          <details>
            <summary>Значения по дням</summary>
            <div className="analytics-table">
              <table>
                <thead>
                  <tr>
                    <th>Дата (UTC)</th>
                    <th>{kinds[kind]}</th>
                  </tr>
                </thead>
                <tbody>
                  {daily.map((d) => (
                    <tr key={d.day}>
                      <td>{d.day}</td>
                      <td>{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary>Версии, системы и источники</summary>
            <p>
              Одна сеть может объединять несколько игроков. Для одинакового
              архива у нескольких версий выбирается последняя опубликованная
              версия. Неизвестные системы показаны отдельно.
            </p>
            <div className="analytics-table">
              <table>
                <thead>
                  <tr>
                    <th>Версия</th>
                    <th>ОС</th>
                    <th>Источник</th>
                    <th>{kinds[kind]}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.breakdown
                    ?.filter((b) => b.kind === kind)
                    .map((b, i) => (
                      <tr key={i}>
                        <td>{b.version || "-"}</td>
                        <td>{b.os === "unknown" ? "Неизвестно" : b.os}</td>
                        <td>{sources[b.source] ?? b.source}</td>
                        <td>{b.count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
