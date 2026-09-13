import test from "node:test";
import assert from "node:assert/strict";
import { ResourceCache, consumerSignal } from "../src/resourceCache.ts";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

test("одинаковые запросы выполняются один раз", async () => {
  const cache = new ResourceCache();
  const pending = deferred<string>();
  let calls = 0;
  const loader = () => {
    calls++;
    return pending.promise;
  };
  const controller = new AbortController();
  const first = consumerSignal(
    cache.read("project", loader),
    controller.signal,
  );
  const second = cache.read("project", loader);
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  pending.resolve("value");
  assert.equal(await second, "value");
  assert.equal(calls, 1);
  assert.equal(await cache.read("project", loader), "value");
  assert.equal(calls, 1);
});
test("старые данные видны во время обновления", async () => {
  let now = 0;
  const cache = new ResourceCache(20, () => now);
  await cache.read("project", async () => 1, 100);
  now = 101;
  const pending = deferred<number>();
  const result = cache.read("project", () => pending.promise, 100);
  assert.equal(cache.peek("project"), 1);
  pending.resolve(2);
  assert.equal(await result, 2);
  assert.equal(await cache.read("project", async () => 3, 100, true), 3);
});
test("ошибка запроса не сохраняется навсегда", async () => {
  let now = 0,
    calls = 0;
  const cache = new ResourceCache(20, () => now);
  const loader = async () => {
    calls++;
    throw Error("offline");
  };
  await assert.rejects(cache.read("absent", loader));
  await assert.rejects(cache.read("absent", loader));
  assert.equal(calls, 1);
  now = 10_001;
  await assert.rejects(cache.read("absent", loader));
  assert.equal(calls, 2);
  assert.equal(await cache.read("absent", async () => 42, 100, true), 42);
});
test("после изменения старый ответ отбрасывается", async () => {
  const cache = new ResourceCache();
  const pending = deferred<number>();
  const old = cache.read("project", () => pending.promise);
  await cache.read("other", async () => 9);
  cache.invalidate((key) => key === "project");
  await cache.read("project", async () => 2);
  pending.resolve(1);
  await assert.rejects(old, { name: "AbortError" });
  assert.equal(cache.peek("project"), 2);
  assert.equal(cache.peek("other"), 9);
});
test("выход очищает личные данные из кэша", async () => {
  const cache = new ResourceCache();
  await cache.read("account-A", async () => ({ secret: "a" }));
  await cache.read("account-B", async () => ({ secret: "b" }));
  const notifications: boolean[] = [];
  cache.subscribe("account-A", (flag) => notifications.push(flag));
  cache.invalidate((key) => key === "account-A", true);
  assert.equal(cache.peek("account-A"), undefined);
  assert.deepEqual(cache.peek("account-B"), { secret: "b" });
  assert.deepEqual(notifications, [false]);
});
test("переполненный кэш удаляет старую запись", async () => {
  const cache = new ResourceCache(2);
  await cache.read("a", async () => 1);
  await cache.read("b", async () => 2);
  await cache.read("a", async () => 3);
  await cache.read("c", async () => 4);
  assert.equal(cache.peek("a"), 1);
  assert.equal(cache.peek("b"), undefined);
  assert.equal(cache.peek("c"), 4);
});
test("данные с диска потом проверяются по сети", async () => {
  const cache = new ResourceCache();
  cache.seed("project", { title: "old" });
  assert.deepEqual(cache.peek("project"), { title: "old" });
  assert.deepEqual(
    await cache.read("project", async () => ({ title: "new" })),
    { title: "new" },
  );
});
test("обновление можно запустить из обработчика", async () => {
  const cache = new ResourceCache();
  await cache.read("a", async () => 1);
  await cache.read("b", async () => 2);
  let notifications = 0;
  const refreshed: Promise<number>[] = [];
  const stop = cache.subscribe("a", (invalidated) => {
    if (invalidated) {
      notifications++;
      refreshed.push(cache.read("a", async () => 3));
    }
  });
  cache.invalidate();
  await Promise.all(refreshed);
  stop();
  assert.equal(notifications, 1);
  assert.equal(cache.peek("a"), 3);
});
test("404 удаляет запись, а временная ошибка оставляет её", async () => {
  const cache = new ResourceCache();
  await cache.read("project", async () => 1);
  await assert.rejects(
    cache.read(
      "project",
      async () => {
        throw Error("offline");
      },
      0,
      true,
    ),
  );
  assert.equal(cache.peek("project"), 1);
  let calls = 0;
  const missing = async () => {
    calls++;
    throw Object.assign(Error("gone"), { status: 404 });
  };
  await assert.rejects(cache.read("project", missing, 0, true));
  assert.equal(cache.peek("project"), undefined);
  await assert.rejects(cache.read("project", missing));
  assert.equal(calls, 1);
});
