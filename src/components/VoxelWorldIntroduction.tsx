import { useEffect, useState } from "react";
import {
  markJointCatalogIntroduced,
  setJointCatalogEnabled,
  shouldIntroduceJointCatalog,
} from "../experimental";
import { hasAnalyticsChoice } from "../telemetry";

export function VoxelWorldIntroduction({
  openCatalog,
}: {
  openCatalog: () => void;
}) {
  const [visible, setVisible] = useState(
    () => hasAnalyticsChoice() && shouldIntroduceJointCatalog(),
  );
  useEffect(() => {
    const showAfterConsent = () => setVisible(shouldIntroduceJointCatalog());
    window.addEventListener("analytics-consent-changed", showAfterConsent);
    return () =>
      window.removeEventListener("analytics-consent-changed", showAfterConsent);
  }, []);
  if (!visible) return null;

  const finish = () => {
    markJointCatalogIntroduced();
    setVisible(false);
  };
  const enable = () => {
    setJointCatalogEnabled(true);
    finish();
    openCatalog();
  };

  return (
    <section className="feature-introduction" aria-label="Интеграция с VoxelWorld">
      <div>
        <span className="experimental-badge">Экспериментально</span>
        <h2>Моды VoxelWorld появились в VLauncher</h2>
        <p>
          Их можно искать рядом с проектами VSpace и устанавливать прямо в
          профиль. Источник каждой карточки всегда указан.
        </p>
      </div>
      <div className="feature-introduction-actions">
        <button className="primary" onClick={enable}>
          Включить и открыть каталог
        </button>
        <button onClick={finish}>Оставить выключенным</button>
      </div>
    </section>
  );
}
