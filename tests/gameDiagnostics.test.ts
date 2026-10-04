import test from "node:test";
import assert from "node:assert/strict";
import { gameFailureLines, gameFailureReport } from "../src/gameDiagnostics.ts";
import type { GameEvent } from "../src/model.ts";
const event: GameEvent = {
  profile_id: "p",
  stream: "process",
  message: "exit status: 1",
  success: false,
  exit_code: 1,
  duration_ms: 1200,
  output_tail: [{ stream: "stderr", message: "missing resource" }],
};

test("failure report preserves current launch diagnostics without mixing old logs", () => {
  const old = [
    { profile_id: "p", stream: "stderr", message: "old error" },
    { profile_id: "other", stream: "stderr", message: "another profile" },
  ];
  const report = gameFailureReport("Шахта", "0.32.0", event, old);
  assert.ok(report.includes("Профиль: Шахта"));
  assert.ok(report.includes("Код завершения: 1"));
  assert.ok(report.includes("Время работы: 1.2 с"));
  assert.ok(report.includes("[stderr] missing resource"));
  assert.ok(!report.includes("old error"));
  assert.deepEqual(gameFailureLines({ ...event, output_tail: [] }, old), []);
});

test("signal termination and older events without structured output remain readable", () => {
  const terminated = {
    ...event,
    exit_code: null,
    signal: 11,
    message: "signal: 11 (SIGSEGV)",
  };
  assert.ok(
    gameFailureReport("Test", "0.32.0", terminated, []).includes("Сигнал: 11"),
  );
  assert.ok(
    !gameFailureReport("Test", "0.32.0", terminated, []).includes(
      "Код завершения:",
    ),
  );
  const logs = Array.from({ length: 100 }, (_, i) => ({
    profile_id: "p",
    stream: "stdout",
    message: String(i),
  }));
  const lines = gameFailureLines({ ...event, output_tail: null }, logs);
  assert.equal(lines.length, 80);
  assert.equal(lines[0].message, "20");
});

test("report uses the runtime from the failed launch after profile version changes", () => {
  const report = gameFailureReport(
    "Test",
    "0.33.0",
    { ...event, runtime_version: "0.32.0" },
    [],
  );
  assert.ok(report.includes("VoxelCore: 0.32.0"));
  assert.ok(!report.includes("VoxelCore: 0.33.0"));
});
