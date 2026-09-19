import assert from "node:assert/strict";
import test from "node:test";
import { mainRequirementFromResolutionError } from "../src/resolutionRequirement.ts";

test("DEV-требование читается из ошибки транзитивной зависимости", () => {
  assert.deepEqual(
    mainRequirementFromResolutionError({
      code: "voxelcore_main_commit_required",
      details: {
        package: "library_b",
        target_version: "0.32.0",
        min_commit: "a".repeat(40),
      },
    }),
    { target_version: "0.32.0", min_commit: "a".repeat(40) },
  );
});

test("посторонняя или неполная ошибка не включает DEV-сборку", () => {
  assert.equal(mainRequirementFromResolutionError(new Error("network")), null);
  assert.equal(
    mainRequirementFromResolutionError({
      code: "voxelcore_main_commit_required",
      details: { target_version: "0.32.0", min_commit: "short" },
    }),
    null,
  );
});
