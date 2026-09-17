import assert from "node:assert/strict";
import test from "node:test";
import { isVoxelCoreBuiltin } from "../src/builtinContent.ts";

test("base распознаётся как встроенный пакет VoxelCore", () => {
  assert.equal(isVoxelCoreBuiltin("base"), true);
  assert.equal(isVoxelCoreBuiltin("base", "vspace"), true);
});

test("обычные и внешние пакеты не считаются встроенными", () => {
  assert.equal(isVoxelCoreBuiltin("base_api"), false);
  assert.equal(isVoxelCoreBuiltin("base", "voxelworld"), false);
});
