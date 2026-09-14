import assert from "node:assert/strict";
import test from "node:test";

import { markdownImage } from "../src/markdownImage.ts";

test("первая картинка из описания используется как визуальный fallback", () => {
  assert.equal(
    markdownImage("Текст\n\n![Обложка](https://vlauncher.space/media/example)"),
    "https://vlauncher.space/media/example",
  );
});

test("обычные ссылки не считаются картинками", () => {
  assert.equal(markdownImage("[Сайт](https://vlauncher.space)"), undefined);
});
