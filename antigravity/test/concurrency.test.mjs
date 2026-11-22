import assert from "node:assert/strict";
import test from "node:test";
import { createKeyedMutex, createSemaphore } from "../src/concurrency.js";

test("createSemaphore enforces cap, FIFO order, abort while waiting, and idempotent release", async () => {
  const sem = createSemaphore(2);
  const order = [];

  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.equal(sem.active, 2);
  assert.equal(sem.pending, 0);

  const p3 = sem.acquire().then((rel) => {
    order.push("w1");
    return rel;
  });
  const ac = new AbortController();
  const pAborted = sem.acquire(ac.signal);
  const p4 = sem.acquire().then((rel) => {
    order.push("w2");
    return rel;
  });

  assert.equal(sem.pending, 3);
  ac.abort(new Error("cancelled"));
  await assert.rejects(pAborted, /cancelled/);
  assert.equal(sem.pending, 2);

  // Idempotent release on r1 only opens one slot
  r1();
  r1();
  const r3 = await p3;
  assert.deepEqual(order, ["w1"]);
  assert.equal(sem.active, 2);

  r2();
  const r4 = await p4;
  assert.deepEqual(order, ["w1", "w2"]);

  r3();
  r4();
  assert.equal(sem.active, 0);
  assert.equal(sem.pending, 0);
});

test("createKeyedMutex runs parallel across keys, serializes same key, and skips wait on undefined key", async () => {
  const mutex = createKeyedMutex();
  const events = [];

  // Same key serializes in call order
  await Promise.all([
    mutex.run("s1", async () => {
      events.push("s1-a-start");
      await new Promise((r) => setTimeout(r, 30));
      events.push("s1-a-end");
    }),
    mutex.run("s1", async () => {
      events.push("s1-b-start");
      events.push("s1-b-end");
    }),
  ]);
  assert.deepEqual(events, ["s1-a-start", "s1-a-end", "s1-b-start", "s1-b-end"]);

  // Different keys run concurrently
  let active = 0;
  let maxActive = 0;
  await Promise.all(
    ["k1", "k2", "k3"].map((k) =>
      mutex.run(k, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 25));
        active -= 1;
      }),
    ),
  );
  assert.equal(maxActive, 3);

  // Undefined key does not block
  let undefActive = 0;
  let undefMax = 0;
  await Promise.all(
    [undefined, undefined].map((k) =>
      mutex.run(k, async () => {
        undefActive += 1;
        undefMax = Math.max(undefMax, undefActive);
        await new Promise((r) => setTimeout(r, 20));
        undefActive -= 1;
      }),
    ),
  );
  assert.equal(undefMax, 2);
});
