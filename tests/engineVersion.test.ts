import assert from "node:assert/strict";
import test from "node:test";
import { engineVersion, exactVoxelCoreVersion, formatVoxelCoreVersion, isDevelopmentVoxelCoreVersion, latestPublishedVoxelCoreVersion, requireEngineVersion, mainBuildLabel, mainRuntimeId, profileEngineLabel, profileModpack, profileRuntimeId, voxelCoreVersionLabel, type LocalProfile, type MainBuild } from "../src/model.ts";

test("сборка main хранит свою версию движка", () => {
  const build: MainBuild = {
    sha: "a".repeat(40), run_id: 1, artifact_id: 2, digest: `sha256:${"b".repeat(64)}`,
    size: 10, created_at: "2026-09-08", expires_at: "2026-12-08", platform: "linux", architecture: "x86_64",
  };
  const profile: LocalProfile = { id: "test", name: "Test", active_revision: "test", voxelcore_version: "0.31.4", roots: [], packages: [], main_build: build };
  assert.equal(engineVersion(profile), "0.31.4");
  const resolved = { ...build, engine_version: "0.32.0" };
  assert.equal(engineVersion({ ...profile, main_build: resolved }), "0.32.0");
  assert.equal(profileRuntimeId({ ...profile, main_build: resolved }), mainRuntimeId(resolved));
  assert.equal(engineVersion({ ...profile, main_build: null }), "0.31.4");
  assert.equal(profileRuntimeId({ ...profile, main_build: null }), "0.31.4");
  assert.equal(mainRuntimeId(resolved), mainRuntimeId(build));
  assert.match(mainBuildLabel(resolved), /0\.32\.0 · DEV \(main\) · aaaaaaa/);
});

test("версия новее последнего релиза помечается как DEV", () => {
  const releases = ["0.9.12", "0.31.4", "0.10.2-beta.1", "not-a-version"];
  const latest = latestPublishedVoxelCoreVersion(releases);
  assert.equal(latest, "0.31.4");
  assert.equal(isDevelopmentVoxelCoreVersion("0.32.0", latest), true);
  assert.equal(isDevelopmentVoxelCoreVersion("0.31.5-beta.1", latest), true);
  assert.equal(isDevelopmentVoxelCoreVersion("0.31.4", latest), false);
  assert.equal(voxelCoreVersionLabel("0.32.0", latest), "0.32.0 · DEV");
  assert.equal(voxelCoreVersionLabel("0.31.4", latest), "0.31.4");
  assert.equal(formatVoxelCoreVersion("0.32"), "0.32.0");
  assert.equal(voxelCoreVersionLabel("0.32", latest), "0.32.0 · DEV");
  const profile: LocalProfile = { id: "dev", name: "Dev", active_revision: null, voxelcore_version: "0.32.0", roots: [], packages: [] };
  assert.equal(profileEngineLabel(profile, latest), "0.32.0 · DEV");
});

test("для пустого профиля версия не придумывается", () => {
  assert.equal(engineVersion(), "");
});

test("операции требуют выбранную версию", () => {
  for (const value of ["", "   "]) {
    assert.throws(() => requireEngineVersion(value), /Выберите версию VoxelCore/);
  }
  assert.equal(requireEngineVersion("0.31.4"), "0.31.4");
  assert.equal(requireEngineVersion("1.2.3-beta.1"), "1.2.3-beta.1");
});

test("сборка определяет профиль и точную версию движка", () => {
  assert.equal(exactVoxelCoreVersion("=0.31.4"), "0.31.4");
  assert.equal(exactVoxelCoreVersion("0.31.4"), "0.31.4");
  assert.equal(exactVoxelCoreVersion("=0.32"), "0.32.0");
  assert.equal(exactVoxelCoreVersion(">=0.31.4"), "");
  const profile: LocalProfile = {
    id: "test",
    name: "Test",
    active_revision: "test",
    voxelcore_version: "0.31.4",
    roots: ["starter_pack"],
    packages: [{ id: "starter_pack", kind: "modpack", version: "2.0.0" }],
  };
  assert.equal(profileModpack(profile)?.version, "2.0.0");
});
