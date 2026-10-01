import assert from "node:assert/strict";
import test from "node:test";
import type { Release } from "../src/api.ts";
import { previousReleaseMainRequirement } from "../src/releaseCompatibility.ts";

const commit = "a".repeat(40);
const requirement = { target_version: "0.32.0", min_commit: commit };
const release = (overrides: Partial<Release> = {}): Release => ({
  id: "latest",
  version: "2.0.0",
  channel: "beta",
  voxelcore: ">=0.32.0",
  artifact_sha256: null,
  artifact_size: null,
  download_url: null,
  attestation: { assertion: { manifest: { voxelcore_main: requirement } } },
  ...overrides,
});

test("new release restores the same DEV commit from the last published version", () => {
  assert.deepEqual(
    previousReleaseMainRequirement([release()], "0.32", "0.31.4"),
    requirement,
  );
});

test("effective DEV requirement takes precedence over the manifest", () => {
  const effective = { ...requirement, min_commit: "b".repeat(40) };
  assert.deepEqual(
    previousReleaseMainRequirement(
      [release({ effective_voxelcore_main: effective })],
      "0.32.0",
      "0.31.4",
    ),
    effective,
  );
});

test("changed engine version and published stable version do not inherit DEV requirements", () => {
  for (const [target, stable] of [
    ["0.33.0", "0.31.4"],
    ["0.32.0", "0.32.0"],
    ["0.32.0", "0.33.0"],
    ["", "0.31.4"],
    ["0.32.0", ""],
  ]) {
    assert.equal(
      previousReleaseMainRequirement([release()], target, stable),
      null,
    );
  }
});

test("a newer release without a DEV requirement does not resurrect an older one", () => {
  assert.equal(
    previousReleaseMainRequirement(
      [release({ attestation: null }), release({ id: "older" })],
      "0.32.0",
      "0.31.4",
    ),
    null,
  );
  assert.equal(previousReleaseMainRequirement([], "0.32.0", "0.31.4"), null);
});

test("malformed inherited commits are not restored", () => {
  assert.equal(
    previousReleaseMainRequirement(
      [
        release({
          effective_voxelcore_main: { ...requirement, min_commit: "invalid" },
        }),
      ],
      "0.32.0",
      "0.31.4",
    ),
    null,
  );
});
