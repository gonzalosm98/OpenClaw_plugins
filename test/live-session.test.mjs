import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSemaphore } from "../src/concurrency.js";
import { __testing, executeAntigravityLiveTurn } from "../src/live-session.js";

function createFakeLiveCapability(fingerprint = "fp-1") {
  let currentHandle;
  const registered = new Set();
  return {
    fingerprint,
    register: (handle) => {
      registered.add(handle);
    },
    current: () => currentHandle,
    activate: (handle) => {
      currentHandle = handle;
    },
    remove: (handle) => {
      registered.delete(handle);
      if (currentHandle === handle) currentHandle = undefined;
    },
    restart: async () => {
      const h = currentHandle;
      currentHandle = undefined;
      for (const handle of [...registered]) {
        handle.close("restart");
        await handle.waitForExit();
      }
      if (h) {
        h.close("restart");
        await h.waitForExit();
      }
    },
  };
}

async function withFakeLiveAgy(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agy-live-test-"));
  const scriptPath = join(dir, "fake-live-agy.mjs");
  const script = `#!${process.execPath}
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const convIdx = args.indexOf("--conversation");
const convId = convIdx >= 0 ? args[convIdx + 1] : "conv-" + process.pid;
let turn = 0;
let cumIn = 0;
let cumOut = 0;
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  turn += 1;
  const msg = JSON.parse(line);
  if (msg.message.content.includes("__HANG__")) {
    if (turn === 1) {
      process.stdout.write(JSON.stringify({ event: "init", conversation_id: convId }) + "\\n");
    }
    return;
  }
  if (msg.message.content.includes("__SLOW__")) {
    process.stdout.write(JSON.stringify({ event: "init", conversation_id: convId }) + "\\n");
    setTimeout(() => {
      process.stdout.write(JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", conversation_id: convId, response: "slow-done" },
      }) + "\\n");
    }, 220);
    return;
  }
  const stepIn = 10;
  const stepOut = 5;
  cumIn += stepIn;
  cumOut += stepOut;
  if (turn === 1) {
    process.stdout.write(JSON.stringify({ event: "init", conversation_id: convId }) + "\\n");
  }
  process.stdout.write(JSON.stringify({
    event: "step_update",
    step_update: {
      step_type: "agent_response",
      step_index: turn,
      state: "DONE",
      text_delta: JSON.stringify({ pid: process.pid, turn, args, content: msg.message.content }),
      usage: { input_tokens: stepIn, output_tokens: stepOut, total_tokens: stepIn + stepOut },
    },
  }) + "\\n");
  process.stdout.write(JSON.stringify({
    event: "result",
    result: {
      status: "SUCCESS",
      conversation_id: convId,
      response: "turn-" + turn,
      usage: { input_tokens: cumIn, output_tokens: cumOut, total_tokens: cumIn + cumOut },
    },
  }) + "\\n");
});
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
  try {
    return await fn(scriptPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runTurn(ctx, deps) {
  const events = [];
  for await (const ev of executeAntigravityLiveTurn(ctx, deps)) {
    events.push(ev);
  }
  return events;
}

test("executeAntigravityLiveTurn reuses warm process across Turn 1 and Turn 2, isolates usage, and emits cached init", async () => {
  await withFakeLiveAgy(async (scriptPath, cwd) => {
    const semaphore = createSemaphore(2);
    const liveSession = createFakeLiveCapability("fp-warm");
    const spawnedPids = [];

    const turn1 = await runTurn(
      {
        command: scriptPath,
        args: ["--mode", "accept-edits"],
        cwd,
        env: process.env,
        systemPrompt: "SYSTEM_ONE",
        prompt: "hello-1",
        liveSession,
        onSpawn: (child) => spawnedPids.push(child.pid),
      },
      { semaphore, idleTimeoutMs: 5_000 },
    );

    assert.equal(spawnedPids.length, 1);
    assert.equal(turn1[0].event, "init");
    const t1Payload = JSON.parse(turn1[1].step_update.text_delta);
    assert.equal(t1Payload.turn, 1);
    assert.match(t1Payload.content, /^SYSTEM_ONE/);
    assert.deepEqual(turn1[2].result.usage, {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      contextUsage: { state: "available", promptTokens: 10, totalTokens: 15 },
    });

    const turn2 = await runTurn(
      {
        command: scriptPath,
        args: ["--mode", "accept-edits", "--resume", turn1[0].conversation_id],
        cwd,
        env: process.env,
        systemPrompt: "SYSTEM_ONE",
        prompt: "hello-2",
        liveSession,
        onSpawn: (child) => spawnedPids.push(child.pid),
      },
      { semaphore, idleTimeoutMs: 5_000 },
    );

    // Same process reused, cached init emitted, systemPrompt omitted, per-turn usage (not cumulative 20/10)
    assert.equal(spawnedPids.length, 1);
    assert.deepEqual(turn2[0], {
      event: "init",
      type: "system",
      subtype: "init",
      conversation_id: `conv-${spawnedPids[0]}`,
    });
    const t2Payload = JSON.parse(turn2[1].step_update.text_delta);
    assert.equal(t2Payload.pid, spawnedPids[0]);
    assert.equal(t2Payload.turn, 2);
    assert.equal(t2Payload.content, "hello-2");
    assert.deepEqual(turn2[2].result.usage, {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      contextUsage: { state: "available", promptTokens: 10, totalTokens: 15 },
    });

    await liveSession.restart();
  });
});

test("executeAntigravityLiveTurn handles registerTurnStatus, registerTurnInterrupt, and --resume -> --conversation on restart", async () => {
  await withFakeLiveAgy(async (scriptPath, cwd) => {
    const semaphore = createSemaphore(2);
    const liveSession = createFakeLiveCapability("fp-int");

    let statusAdapter;
    let interruptCtrl;
    const events = [];
    for await (const ev of executeAntigravityLiveTurn(
      {
        command: scriptPath,
        args: [],
        cwd,
        env: process.env,
        prompt: "__HANG__",
        liveSession,
        registerTurnStatus: (a) => {
          statusAdapter = a.capture();
        },
        registerTurnInterrupt: (c) => {
          interruptCtrl = c;
        },
      },
      { semaphore, idleTimeoutMs: 5_000 },
    )) {
      events.push(ev);
      if (ev.event === "init") {
        const activeAssessment = await statusAdapter.assess();
        assert.equal(activeAssessment.state, "unknown");
        assert.equal(activeAssessment.basis, "process_present");
        await interruptCtrl.interrupt();
      }
    }

    const last = events.at(-1);
    assert.equal(last.event, "result");
    assert.equal(last.is_error, false);
    assert.ok(last.result.conversation_id.startsWith("conv-"));
    const closedAssessment = await statusAdapter.assess();
    assert.equal(closedAssessment.state, "unknown");
    assert.equal(closedAssessment.basis, "status_unsupported");

    // Next turn after interrupt resumes with --conversation
    const nextTurn = await runTurn(
      {
        command: scriptPath,
        args: ["--resume", last.result.conversation_id],
        cwd,
        env: process.env,
        prompt: "after-interrupt",
        liveSession,
      },
      { semaphore, idleTimeoutMs: 5_000 },
    );
    const nextPayload = JSON.parse(nextTurn[1].step_update.text_delta);
    assert.ok(nextPayload.args.includes("--conversation"));
    assert.ok(nextPayload.args.includes(last.result.conversation_id));
    assert.equal(nextPayload.args.includes("--resume"), false);

    await liveSession.restart();
  });
});

test("executeAntigravityLiveTurn evicts on idle timeout and restarts on fingerprint mismatch", async () => {
  await withFakeLiveAgy(async (scriptPath, cwd) => {
    const semaphore = createSemaphore(2);
    const liveSession = createFakeLiveCapability("fp-1");
    const pids = [];

    await runTurn(
      {
        command: scriptPath,
        args: [],
        cwd,
        env: process.env,
        prompt: "t1",
        liveSession,
        onSpawn: (c) => pids.push(c.pid),
      },
      { semaphore, idleTimeoutMs: 50 },
    );

    const handleAfterT1 = liveSession.current();
    assert.ok(handleAfterT1);
    await new Promise((r) => setTimeout(r, 90));
    await handleAfterT1.waitForExit();
    assert.equal(__testing.sessions.get(handleAfterT1).closed, true);

    // Fingerprint mismatch restarts
    await runTurn(
      {
        command: scriptPath,
        args: [],
        cwd,
        env: process.env,
        prompt: "t2",
        liveSession,
        onSpawn: (c) => pids.push(c.pid),
      },
      { semaphore, idleTimeoutMs: 5_000 },
    );
    liveSession.fingerprint = "fp-2";
    await runTurn(
      {
        command: scriptPath,
        args: [],
        cwd,
        env: process.env,
        prompt: "t3",
        liveSession,
        onSpawn: (c) => pids.push(c.pid),
      },
      { semaphore, idleTimeoutMs: 5_000 },
    );
    assert.equal(pids.length, 3);
    assert.notEqual(pids[1], pids[2]);

    await liveSession.restart();
  });
});

test("executeAntigravityLiveTurn emits keepalives bounded by maxSilentMs", async () => {
  await withFakeLiveAgy(async (scriptPath, cwd) => {
    const semaphore = createSemaphore(1);
    const liveSession = createFakeLiveCapability("fp-ka");

    // Warm up the process so Turn 1 startup `init` does not reset the silence timer mid-test.
    await runTurn(
      {
        command: scriptPath,
        args: [],
        cwd,
        env: process.env,
        prompt: "warmup",
        liveSession,
      },
      { semaphore, keepaliveIntervalMs: 5_000, maxSilentMs: 10_000, idleTimeoutMs: 5_000 },
    );

    const events = await runTurn(
      {
        command: scriptPath,
        args: [],
        cwd,
        env: process.env,
        prompt: "__SLOW__",
        liveSession,
      },
      { semaphore, keepaliveIntervalMs: 30, maxSilentMs: 90, idleTimeoutMs: 5_000 },
    );

    const keepalives = events.filter((e) => e.event === "openclaw_keepalive");
    assert.ok(keepalives.length >= 1 && keepalives.length <= 3, `got ${keepalives.length}`);
    assert.ok(keepalives.every((e) => e.elapsed_seconds === 0));
    assert.equal(events.at(-1).event, "result");

    await liveSession.restart();
  });
});
