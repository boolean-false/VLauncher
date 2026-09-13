import assert from "node:assert/strict";
import test from "node:test";
import {
  displayFiles,
  filesReady,
  groupReleases,
  type LauncherRelease,
} from "../src/launcherReleases.ts";
const file = {
  id: "a",
  kind: "installer",
  filename: "app.exe",
  size: 100,
  sha256: "a".repeat(64),
};
const build = (overrides: Partial<LauncherRelease> = {}): LauncherRelease => ({
  id: "1",
  version: "1.0.0",
  channel: "stable",
  target: "windows",
  architecture: "x86_64",
  status: "draft",
  notes: "Notes",
  files: [file, { ...file, id: "b", kind: "update" }],
  ...overrides,
});
test("файлы одной версии собираются вместе", () => {
  const groups = groupReleases([
    build(),
    build({ id: "2", target: "linux" }),
    build({ id: "3", channel: "beta" }),
    build({ id: "4", version: "1.0.10" }),
    build({ id: "5", version: "1.0.2" }),
  ]);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].version, "1.0.10");
  assert.equal(groups.find((g) => g.key === "1.0.0/stable")?.builds.length, 2);
});
test("для релиза нужны оба файла", () => {
  assert.equal(filesReady(build()), true);
  for (const files of [
    [file],
    [file, { ...file, kind: "update", size: 0 }],
    [file, { ...file, kind: "update", sha256: "" }],
  ])
    assert.equal(filesReady(build({ files })), false);
});
test("одинаковый файл можно использовать дважды", () => {
  const files = build().files;
  assert.deepEqual(displayFiles(files)[0].kinds, ["installer", "update"]);
  assert.equal(displayFiles(files).length, 1);
  assert.equal(
    displayFiles([file, { ...file, sha256: "b".repeat(64) }]).length,
    2,
  );
  assert.equal(
    displayFiles([
      { ...file, sha256: "" },
      { ...file, sha256: "" },
    ]).length,
    2,
  );
});
test("стабильные версии показываются раньше тестовых", () => {
  const versions = ["1.0.1-beta.2", "1.0.1", "1.0.1-beta.10", "1.0.0"];
  assert.deepEqual(
    groupReleases(versions.map((version) => build({ version }))).map(
      (g) => g.version,
    ),
    ["1.0.1", "1.0.1-beta.10", "1.0.1-beta.2", "1.0.0"],
  );
});
