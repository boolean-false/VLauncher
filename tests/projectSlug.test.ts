import assert from "node:assert/strict";
import test from "node:test";
import { projectSlugFromTitle, validProjectSlug } from "../src/projectSlug.ts";

test("адрес карты или сборки получается читаемым", () => {
  assert.equal(projectSlugFromTitle("Парящие острова"), "paryaschie-ostrova");
  assert.equal(projectSlugFromTitle("My Modpack 2"), "my-modpack-2");
});

test("публичный адрес имеет безопасный формат", () => {
  assert.equal(validProjectSlug("floating-islands"), true);
  assert.equal(validProjectSlug("wire_mod"), true);
  assert.equal(validProjectSlug("Сложный адрес"), false);
  assert.equal(validProjectSlug("a"), false);
});
