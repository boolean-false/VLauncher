import assert from "node:assert/strict";
import test from "node:test";
import { findContentUpdates } from "../src/contentUpdates.ts";
import type { LocalProfile } from "../src/model.ts";
import type { Release, SignedInstallPlan } from "../src/api.ts";
const profile = {
  id: "test",
  name: "Test",
  voxelcore_version: "0.32.0",
  active_revision: "one",
  roots: ["client"],
  packages: [{ id: "client", version: "1.0.0", kind: "mod" }],
} as LocalProfile;
const release = (version: string, channel = "stable") =>
  ({
    version,
    channel,
    download_url: "https://example.test/file",
    voxelcore: ">=0.32.0",
  }) as Release;
const plan = (id: string, version: string) =>
  ({ plan: { packages: [{ id, version }] } }) as SignedInstallPlan;

test("background check keeps current runtime and distinguishes compatible from newer releases", async () => {
  const result = await findContentUpdates(
    profile,
    async () => [
      release("1.0.0", "beta"),
      release("2.0.0", "beta"),
      release("3.0.0", "alpha"),
    ],
    async (
      roots,
      engine,
      requirements,
      channels,
      _locked,
      _direct,
      runtime,
    ) => {
      assert.deepEqual(roots, ["client"]);
      assert.equal(engine, "0.32.0");
      assert.deepEqual(runtime, { kind: "stable", version: "0.32.0" });
      assert.deepEqual(requirements, { client: ">=1.0.0 <=2.0.0" });
      assert.deepEqual(channels, ["stable", "beta"]);
      return plan("client", "1.0.0");
    },
  );
  assert.deepEqual(result.versions, {});
  assert.deepEqual(result.newer, { client: "2.0.0" });
});

test("compatible update appears without modifying installed profile", async () => {
  const result = await findContentUpdates(
    profile,
    async () => [release("1.0.0"), release("1.1.0")],
    async () => plan("client", "1.1.0"),
  );
  assert.deepEqual(result.versions, { client: "1.1.0" });
  assert.equal(profile.packages[0].version, "1.0.0");
});

test("direct projects use exact versions and retain current version when newer release needs another engine", async () => {
  const id = "12345678-1234-1234-8234-123456789012";
  let calls = 0;
  const result = await findContentUpdates(
    {
      ...profile,
      roots: [id],
      packages: [{ id, version: "1.0.0", kind: "modpack" }],
    },
    async () => [release("1.0.0"), release("2.0.0")],
    async (_roots, _engine, requirements) => {
      calls++;
      assert.equal(requirements?.[id], calls === 1 ? "=2.0.0" : "=1.0.0");
      if (calls === 1)
        throw Object.assign(Error("incompatible engine"), {
          code: "no_compatible_release",
        });
      return plan(id, "1.0.0");
    },
  );
  assert.equal(calls, 2);
  assert.deepEqual(result.versions, {});
  assert.equal(result.newer[id], "2.0.0");
});

test("installed beta packages do not opt stable roots into beta updates", async () => {
  const mixed = {
    ...profile,
    roots: ["client", "stable"],
    packages: [
      ...profile.packages,
      { id: "stable", version: "1.0.0", kind: "mod" as const },
    ],
  };
  await findContentUpdates(
    mixed,
    async (id) =>
      id === "client"
        ? [release("1.0.0", "beta"), release("2.0.0", "beta")]
        : [release("1.0.0"), release("1.1.0"), release("2.0.0", "beta")],
    async (_roots, _engine, requirements, channels) => {
      assert.deepEqual(channels, ["stable", "beta"]);
      assert.equal(requirements?.stable, ">=1.0.0 <=1.1.0");
      return plan("stable", "1.1.0");
    },
  );
});

test("direct project fallback does not hide network failures", async () => {
  const id = "12345678-1234-1234-8234-123456789012";
  let calls = 0;
  const error = Object.assign(Error("HTTP 503"), { status: 503 });
  await assert.rejects(
    findContentUpdates(
      {
        ...profile,
        roots: [id],
        packages: [{ id, version: "1.0.0", kind: "modpack" }],
      },
      async () => [release("1.0.0"), release("2.0.0")],
      async () => {
        calls++;
        throw error;
      },
    ),
    error,
  );
  assert.equal(calls, 1);
});
