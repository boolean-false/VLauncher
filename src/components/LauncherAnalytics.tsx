import { useEffect, useState } from "react";
import { registryRequest } from "../api";
type Data = {
  summary: {
    new_installations: number;
    new_accounts: number;
    launcher_downloads: number;
    dau: number;
    wau: number;
    mau: number;
    starts: number;
    game_starts: number;
    returning: number;
  };
  daily: {
    day: string;
    new_installations: number;
    active: number;
    starts: number;
    game_starts: number;
  }[];
  breakdown: {
    os: string;
    version: string;
    installations: number;
    starts: number;
  }[];
  downloads_started_at: string;
  started_at: string;
  retention_days: number;
};
export function LauncherAnalytics({
  token,
  revision,
}: {
  token: string;
  revision: number;
}) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError("");
    void registryRequest<Data>(
      `/admin/analytics/launcher?days=${days}`,
      { cache: "no-store" },
      token,
    )
      .then((d) => {
        if (live) setData(d);
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
  }, [token, days, revision, retry]);
  const labels = {
    new_installations: "Новые установки в статистике",
    new_accounts: "Новые аккаунты за период",
    launcher_downloads: "Скачивания лаунчера за период",
    dau: "Активны сегодня",
    wau: "Активны за 7 дней",
    mau: "Активны за 30 дней",
    starts: "Запуски за период",
    game_starts: "Запуски игры за период",
    returning: "Активны в разные дни периода",
  };
  return (
    <section className="team-settings">
      <h3>Использование VLauncher</h3>
      <p>
        Только установки, которые включили добровольную статистику. Один человек
        может иметь несколько установок; после сброса идентификатора установка
        будет новой. Офлайн-события не накапливаются. Это не общее число
        игроков.
      </p>
      <p>
        Новые установки - впервые замеченные участники статистики. Позднее
        согласие, сброс идентификатора или возвращение после 90 дней без
        активности могут считаться новой установкой. Регистрации аккаунтов и
        скачивания лаунчера учитываются отдельно, независимо от согласия в
        приложении.
      </p>
      <div className="analytics-controls">
        <label>
          Период
          <select
            aria-label="Период"
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setData(null);
            }}
          >
            {[7, 30, 90].map((n) => (
              <option key={n} value={n}>
                {n} дней
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy} onClick={() => setRetry((n) => n + 1)}>
          {busy ? "Обновляем…" : "Обновить"}
        </button>
      </div>
      {error && (
        <p role="alert" className="error-notice">
          {error}
        </p>
      )}
      {data && (
        <>
          <p>
            Сбор доступен с {new Date(data.started_at).toLocaleDateString("ru")}
            . Хранение активности - {data.retention_days} дней. Даты - UTC.
          </p>
          <p>
            Скачивания файлов лаунчера и обновлений считаются с{" "}
            {data.downloads_started_at ? new Date(data.downloads_started_at).toLocaleDateString("ru") : "обновления сервера"};
            повторы одного файла из одной сети за сутки объединяются. Это не
            установки.
          </p>
          <div className="analytics-summary">
            {Object.entries(labels).map(([key, label]) => (
              <div key={key}>
                <strong>
                  {data.summary[key as keyof Data["summary"]]?.toLocaleString(
                    "ru",
                  ) ?? "-"}
                </strong>
                <span>{label}</span>
              </div>
            ))}
          </div>
          {!data.daily.some((d) => d.active) && (
            <p>
              Данных пока нет: нужны запуски новой версии с включённой
              статистикой.
            </p>
          )}
          <div className="analytics-table">
            <table>
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Новые в статистике</th>
                  <th>Активные установки</th>
                  <th>Запуски</th>
                  <th>Запуски игры</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((d) => (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td>{d.new_installations ?? "-"}</td>
                    <td>{d.active}</td>
                    <td>{d.starts}</td>
                    <td>{d.game_starts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Версии и системы</h3>
          <p>
            Обновившаяся установка может присутствовать в нескольких строках.
          </p>
          <div className="analytics-table">
            <table>
              <thead>
                <tr>
                  <th>ОС</th>
                  <th>Версия</th>
                  <th>Установки</th>
                  <th>Запуски</th>
                </tr>
              </thead>
              <tbody>
                {data.breakdown.map((b, i) => (
                  <tr key={i}>
                    <td>{b.os}</td>
                    <td>{b.version}</td>
                    <td>{b.installations}</td>
                    <td>{b.starts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
