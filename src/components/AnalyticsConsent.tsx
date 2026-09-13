import { useEffect, useState } from "react";
import { hasAnalyticsChoice, setAnalyticsConsent } from "../telemetry";

export function AnalyticsDetails() {
  return (
    <details>
      <summary>Какие данные отправляются</summary>
      <p>
        Запуски приложения и игры, дни активности, версия VLauncher, ОС,
        просмотры и установки проектов. Для подсчёта используется случайный
        номер, который не связан с аккаунтом. Имена миров, пути и личные пакеты
        не отправляются.
      </p>
      <p>
        Активность хранится 90 дней, запись об установке - до 90 дней без
        активности. При отключении отправка прекращается и локальный
        идентификатор удаляется.
      </p>
    </details>
  );
}

export function AnalyticsConsent() {
  const [visible, setVisible] = useState(() => !hasAnalyticsChoice());
  const [error, setError] = useState("");
  useEffect(() => {
    const changed = () => setVisible(!hasAnalyticsChoice());
    window.addEventListener("analytics-consent-changed", changed);
    return () =>
      window.removeEventListener("analytics-consent-changed", changed);
  }, []);
  if (!visible) return null;
  function choose(value: boolean) {
    try {
      setAnalyticsConsent(value);
      setVisible(false);
    } catch {
      setError("Не удалось сохранить выбор. Попробуйте ещё раз.");
    }
  }
  return (
    <section className="analytics-consent" aria-label="Участие в статистике">
      <div>
        <h2>Разрешить статистику использования?</h2>
        <p>
          Так мы сможем примерно понять, сколько людей пользуется лаунчером.
          Выбор потом можно изменить в настройках.
        </p>
        <AnalyticsDetails />
        {error && (
          <p role="alert" className="error-notice">
            {error}
          </p>
        )}
      </div>
      <div className="analytics-consent-actions">
        <button className="primary" onClick={() => choose(true)}>
          Разрешить
        </button>
        <button onClick={() => choose(false)}>Не сейчас</button>
      </div>
    </section>
  );
}
