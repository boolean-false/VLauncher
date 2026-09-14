import { useEffect, useState } from "react";

const jointCatalogKey = "vlauncher.experimental.joint-catalog";
const jointCatalogEvent = "vlauncher-joint-catalog-changed";
const jointCatalogIntroductionKey =
  "vlauncher.experimental.joint-catalog-introduction.v1";

export function readJointCatalogEnabled() {
  return localStorage.getItem(jointCatalogKey) === "true";
}

export function setJointCatalogEnabled(enabled: boolean) {
  localStorage.setItem(jointCatalogKey, String(enabled));
  window.dispatchEvent(new CustomEvent(jointCatalogEvent, { detail: enabled }));
}

export function useJointCatalogEnabled() {
  const [enabled, setEnabled] = useState(readJointCatalogEnabled);
  useEffect(() => {
    const changed = (event: Event) =>
      setEnabled((event as CustomEvent<boolean>).detail);
    window.addEventListener(jointCatalogEvent, changed);
    return () => window.removeEventListener(jointCatalogEvent, changed);
  }, []);
  return enabled;
}

export function shouldIntroduceJointCatalog() {
  return (
    !readJointCatalogEnabled() &&
    localStorage.getItem(jointCatalogIntroductionKey) !== "seen"
  );
}

export function markJointCatalogIntroduced() {
  localStorage.setItem(jointCatalogIntroductionKey, "seen");
}
