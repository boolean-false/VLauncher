import assert from "node:assert/strict";
import test from "node:test";
import { sameCatalogProject } from "../src/catalogIdentity.ts";

test("одинаковый проект из двух каталогов определяется по названию", () => {
  assert.equal(
    sameCatalogProject(
      { slug: "noteblock-mod", title: "Noteblock Mod" },
      { slug: "noteblock", title: "NoteBlock mod" },
    ),
    true,
  );
});

test("разные проекты остаются в общем каталоге", () => {
  assert.equal(
    sameCatalogProject(
      { slug: "noteblock-mod", title: "Noteblock Mod" },
      { slug: "resties", title: "Resties" },
    ),
    false,
  );
});
