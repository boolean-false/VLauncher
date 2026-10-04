import assert from "node:assert/strict";
import test from "node:test";
import { retryDownload } from "../src/downloadRetry.ts";

test("503 retries and then returns the successful download", async () => {
  let attempts = 0;
  const messages: number[] = [];
  const result = await retryDownload(
    async () => {
      if (++attempts < 3) throw Error("status: 503 Service Unavailable");
      return "file";
    },
    new AbortController().signal,
    (n) => messages.push(n),
    [0, 0],
  );
  assert.equal(result, "file");
  assert.deepEqual(messages, [2, 3]);
});

test("invalid signature, hash and 404 are never retried", async () => {
  for (const message of [
    "invalid signature",
    "hash mismatch",
    "status: 404 Not Found",
    "could not open profile 503",
    "invalid package 500",
  ]) {
    let calls = 0;
    await assert.rejects(
      retryDownload(
        async () => {
          calls++;
          throw Error(message);
        },
        new AbortController().signal,
        () => assert.fail("must not retry"),
        [0],
      ),
    );
    assert.equal(calls, 1);
  }
});

test("cancelling the retry wait prevents another download", async () => {
  const control = new AbortController();
  let calls = 0;
  await assert.rejects(
    retryDownload(
      async () => {
        calls++;
        throw Error("status: 503");
      },
      control.signal,
      () => control.abort(),
      [1000],
    ),
  );
  assert.equal(calls, 1);
});

test("persistent failures stop after three attempts", async () => {
  let calls = 0;
  await assert.rejects(
    retryDownload(
      async () => {
        calls++;
        throw Error("connection reset");
      },
      new AbortController().signal,
      () => {},
      [0, 0],
    ),
  );
  assert.equal(calls, 3);
});
