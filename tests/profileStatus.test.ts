import { test } from "node:test";
import assert from "node:assert/strict";
import { profileStatus } from "../src/profileStatus.ts";

const idle = { running: false, version: "0.32.7", installed: false };
test("first install, installed game and explicit launch phases have consistent actions", () => {
  assert.equal(profileStatus(idle).action, "Установить и играть");
  assert.equal(profileStatus({ ...idle, installed: true }).action, "Играть");
  assert.equal(
    profileStatus({ ...idle, phase: "installing" }).label,
    "Скачиваем и устанавливаем…",
  );
  assert.equal(
    profileStatus({ ...idle, phase: "launching" }).action,
    "Запускаем…",
  );
  assert.equal(
    profileStatus({ ...idle, running: true, phase: "launching" }).state,
    "running",
  );
});
test("failed installs and failed launches offer the appropriate retry", () => {
  assert.equal(
    profileStatus({ ...idle, error: "network" }).action,
    "Повторить установку",
  );
  assert.equal(
    profileStatus({ ...idle, error: "process", installed: true }).action,
    "Повторить запуск",
  );
  assert.equal(
    profileStatus({ ...idle, error: "previous", phase: "checking" }).state,
    "checking",
  );
  assert.equal(
    profileStatus({ ...idle, problem: "missing folder" }).state,
    "unavailable",
  );
});
