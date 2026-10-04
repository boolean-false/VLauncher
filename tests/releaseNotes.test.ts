import test from "node:test";
import assert from "node:assert/strict";
import { updateReleaseNotes } from "../src/releaseNotes.ts";

test("release notes include skipped releases in descending order without unrelated channels", () => {
  const releases = [
    { version: "1.0.0", channel: "stable" },
    { version: "1.1.0", channel: "stable", changelog: "First changes" },
    { version: "1.2.0", channel: "alpha" },
    { version: "1.3.0", channel: "stable", changelog: "Latest changes" },
    { version: "1.4.0", channel: "stable" },
  ];
  assert.deepEqual(
    updateReleaseNotes(releases, "1.0.0", "1.3.0").map((r) => r.version),
    ["1.3.0", "1.1.0"],
  );
  assert.equal(releases[0].version, "1.0.0");
});

test("beta target includes beta and stable notes and preserves empty changelogs", () => {
  const releases = [
    { version: "2.0.0-beta.1", channel: "beta", changelog: "" },
    { version: "1.9.0", channel: "stable", changelog: "" },
    { version: "2.0.0-alpha.1", channel: "alpha" },
  ];
  assert.deepEqual(
    updateReleaseNotes(releases, "1.8.0", "2.0.0-beta.1").map((r) => r.version),
    ["2.0.0-beta.1", "1.9.0"],
  );
  assert.deepEqual(updateReleaseNotes([], "1.0.0", "2.0.0"), []);
});
