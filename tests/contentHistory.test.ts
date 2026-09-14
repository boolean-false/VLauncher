import assert from "node:assert/strict";
import test from "node:test";
import { visitContent } from "../src/contentHistory.ts";

test("dependency cycles return to an existing entry without losing its context", () => {
  const root = {
    source: "vspace",
    slug: "root",
    version: "1.0.0",
    parent: "Profile",
  };
  const dependency = { source: "vspace", slug: "dependency", version: "2.0.0" };
  assert.deepEqual(
    visitContent([root, dependency], { ...root, parent: "dependency" }),
    [root],
  );
});
test("different sources and versions remain separate history entries", () => {
  const root = { source: "vspace", slug: "same", version: "1.0.0" };
  assert.equal(
    visitContent([root], { ...root, source: "extension" }).length,
    2,
  );
  assert.equal(visitContent([root], { ...root, version: "2.0.0" }).length, 2);
});
