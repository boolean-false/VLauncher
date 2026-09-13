import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireImage,
  clearImageSession,
  peekImage,
} from "../src/imageCache.ts";

test("картинка загружается один раз и очищается после выхода", async () => {
  const original = globalThis.fetch;
  Object.assign(globalThis, { window: new EventTarget() });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(new Blob(["image"], { type: "image/webp" }));
  };
  try {
    const [a, b] = await Promise.all([
      acquireImage("https://test/image", "A"),
      acquireImage("https://test/image", "A"),
    ]);
    assert.equal(calls, 1);
    assert.equal(a.url, b.url);
    a.release();
    b.release();
    const c = await acquireImage("https://test/image", "A");
    assert.equal(calls, 1);
    c.release();
    const other = await acquireImage("https://test/image", "B");
    assert.equal(calls, 2);
    other.release();
    clearImageSession("A");
    assert.equal(peekImage("https://test/image", "A"), "");
    assert.notEqual(peekImage("https://test/image", "B"), "");
    let resolve!: (response: Response) => void;
    globalThis.fetch = () => new Promise((r) => (resolve = r));
    const late = acquireImage("https://test/late", "A");
    clearImageSession("A");
    resolve(new Response(new Blob(["old"])));
    await assert.rejects(late);
    assert.equal(peekImage("https://test/late", "A"), "");
    clearImageSession("B");
  } finally {
    globalThis.fetch = original;
  }
});
