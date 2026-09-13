import test from "node:test";
import assert from "node:assert/strict";
import { ResourceCache } from "../src/resourceCache.ts";
import { connectPublicMetadata } from "../src/publicMetadataCache.ts";

test("в кэш попадают только подходящие публичные данные", async () => {
  const storage = new Map<string, string>();
  Object.assign(globalThis, {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  });
  const registry = "https://example/api";
  const key = (path: string, token = "") =>
    JSON.stringify([registry, token, path]);
  const valid = {
    slug: "mod",
    type: "mod",
    title: "Mod",
    summary: "summary",
    description: "description",
  };
  const cache = new ResourceCache();
  connectPublicMetadata(cache, registry);
  await cache.read(key("/projects/mod"), async () => valid);
  await cache.read(key("/creator/projects", "secret-token"), async () => [
    { secret: "private" },
  ]);
  await cache.read(key("/projects/mod/releases"), async () => [
    { version: "1" },
  ]);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const raw = storage.get("vlauncher.public-metadata.v1")!;
  assert.ok(!raw.includes("secret-token"));
  assert.ok(!raw.includes("/releases"));
  assert.equal(JSON.parse(raw).length, 1);
  const restored = new ResourceCache();
  connectPublicMetadata(restored, registry);
  assert.deepEqual(restored.peek(key("/projects/mod")), valid);
  const foreign = new ResourceCache();
  connectPublicMetadata(foreign, "https://other/api");
  assert.equal(foreign.peek(key("/projects/mod")), undefined);
  storage.set(
    "vlauncher.public-metadata.v1",
    JSON.stringify([
      {
        key: key("/projects?kind=mod"),
        at: Date.now(),
        value: { items: "broken" },
      },
    ]),
  );
  const corrupted = new ResourceCache();
  connectPublicMetadata(corrupted, registry);
  assert.equal(corrupted.peek(key("/projects?kind=mod")), undefined);
});
