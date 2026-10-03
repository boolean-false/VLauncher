import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWithBuildFallback,
  selectVerifiedBuild,
} from "../src/runtimeSelection.ts";
import type { MainBuild } from "../src/model.ts";
const build = (id: number, version = "0.32.0"): MainBuild => ({
  engine_version: version,
  artifact_id: id,
  sha: String(id).repeat(40),
  run_id: id,
  digest: "a".repeat(64),
  size: 10,
  created_at: `2026-09-${String(id).padStart(2, "0")}T00:00:00Z`,
  expires_at: "2026-12-01T00:00:00Z",
  platform: "windows",
  architecture: "x86_64",
});
const gate = {
  code: "voxelcore_main_commit_required",
  details: { target_version: "0.32.0", min_commit: "b".repeat(40) },
};

test("compatible current runtime needs neither catalog access nor experimental opt-in", async () => {
  const result = await resolveWithBuildFallback(
    async () => "current plan",
    async () => {
      throw new Error("must not fetch");
    },
    async () => {
      throw new Error("must not verify");
    },
  );
  assert.deepEqual(result, { value: "current plan" });
});

test("dependency gate verifies actual builds with the full plan, newest first", async () => {
  const attempted: number[] = [];
  const result = await resolveWithBuildFallback(
    async () => {
      throw gate;
    },
    async () => [build(1), build(3, "0.33.0"), build(2, "0.32")],
    async (candidate) => {
      attempted.push(candidate.artifact_id);
      if (candidate.artifact_id === 2) throw { code: "no_compatible_release" };
      return "verified plan";
    },
  );
  assert.deepEqual(attempted, [2, 1]);
  assert.equal(result.build?.artifact_id, 1);
  assert.equal(result.value, "verified plan");
});

test("same version with insufficient commits never becomes a recommendation", async () => {
  await assert.rejects(
    resolveWithBuildFallback(
      async () => {
        throw gate;
      },
      async () => [build(1), build(2)],
      async () => {
        throw gate;
      },
    ),
    /Подходящая DEV-сборка пока недоступна/,
  );
});

test("unavailable server checks are not reported as missing artifacts or bypassed", async () => {
  const error = { code: "voxelcore_commit_check_unavailable" };
  const attempted: number[] = [];
  await assert.rejects(
    selectVerifiedBuild([build(1), build(2)], async (candidate) => {
      attempted.push(candidate.artifact_id);
      throw error;
    }),
    (value) => value === error,
  );
  assert.deepEqual(attempted, [2]);
});

test("ordinary package conflicts do not trigger an unsolicited engine change", async () => {
  const error = { code: "package_conflict" };
  await assert.rejects(
    resolveWithBuildFallback(
      async () => {
        throw error;
      },
      async () => {
        throw new Error("must not fetch");
      },
      async () => "bad",
    ),
    (value) => value === error,
  );
});

test("explicit experimental update handles empty catalogs", async () => {
  await assert.rejects(
    selectVerifiedBuild([], async () => "bad"),
    /пока недоступна/,
  );
});

test("published stable release is verified before querying DEV builds", async () => {
  const result = await resolveWithBuildFallback(
    async () => {
      throw gate;
    },
    async () => {
      throw new Error("must not fetch DEV builds");
    },
    async () => {
      throw new Error("must not verify DEV builds");
    },
    async () => ({ value: "stable 0.32 plan" }),
  );
  assert.deepEqual(result, { value: "stable 0.32 plan" });
});

test("stable upgrade can resolve a future mod without a DEV commit gate", async () => {
  const result = await resolveWithBuildFallback(
    async () => {
      throw { code: "no_compatible_release" };
    },
    async () => {
      throw new Error("must not fetch DEV builds");
    },
    async () => {
      throw new Error("must not verify DEV builds");
    },
    async () => ({ value: "stable full dependency plan" }),
  );
  assert.equal(result.value, "stable full dependency plan");
});

test("unreleased target still falls back to a verified DEV build", async () => {
  const result = await resolveWithBuildFallback(
    async () => {
      throw { code: "no_compatible_release" };
    },
    async () => [build(1)],
    async () => "DEV plan",
    async () => {
      throw gate;
    },
  );
  assert.equal(result.value, "DEV plan");
  assert.equal(result.build?.artifact_id, 1);
});

test("stable verification transport errors do not trigger a DEV switch", async () => {
  const unavailable = { code: "network_unavailable" };
  await assert.rejects(
    resolveWithBuildFallback(
      async () => {
        throw gate;
      },
      async () => {
        throw new Error("must not fetch");
      },
      async () => "DEV plan",
      async () => {
        throw unavailable;
      },
    ),
    (error) => error === unavailable,
  );
});
