// Small concurrency primitives shared by the CLI backend and live sessions.

function abortError(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

/**
 * Counting semaphore with a FIFO wait queue.
 *
 * `acquire(signal?)` resolves to an idempotent `release()`. If the signal aborts
 * while waiting, the waiter removes itself from the queue and rejects.
 *
 * @param {number} max
 */
export function createSemaphore(max) {
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  let active = 0;
  /** @type {{ grant: () => void, cancel: () => void }[]} */
  const queue = [];

  const makeRelease = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active -= 1;
      drain();
    };
  };

  function drain() {
    while (active < limit && queue.length > 0) {
      const waiter = queue.shift();
      waiter.grant();
    }
  }

  return {
    acquire(signal) {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (active < limit && queue.length === 0) {
        active += 1;
        return Promise.resolve(makeRelease());
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          grant: () => {
            signal?.removeEventListener("abort", onAbort);
            active += 1;
            resolve(makeRelease());
          },
          cancel: () => {},
        };
        const onAbort = () => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(abortError(signal));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(waiter);
      });
    },
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
  };
}

/**
 * Per-key mutex. Same key → serialized in call order; different keys (or an
 * undefined key) → no waiting.
 */
export function createKeyedMutex() {
  /** @type {Map<unknown, Promise<void>>} */
  const tails = new Map();

  /** Resolves to a release function once the caller owns `key`. */
  async function lock(key) {
    if (key === undefined || key === null) return () => {};
    const previous = tails.get(key) ?? Promise.resolve();
    let open;
    const gate = new Promise((resolve) => {
      open = resolve;
    });
    const tail = previous.then(() => gate);
    tails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      open();
      if (tails.get(key) === tail) tails.delete(key);
    };
  }

  return {
    lock,
    async run(key, fn) {
      const release = await lock(key);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}
