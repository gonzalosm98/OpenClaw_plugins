import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agyUserMessage,
  composeAgyPrompt,
  createKeepalive,
  createTurnAccumulator,
  executeAntigravityStream,
  normalizeAgyArgs,
  parseAntigravityJsonlEvent,
  syntheticInterruptResult,
} from "../src/stream.js";

async function withFakeCli(scriptBody, fn) {
  const dir = await mkdtemp(join(tmpdir(), "agy-stream-test-"));
  const scriptPath = join(dir, "fake-agy.mjs");
  await writeFile(scriptPath, `#!${process.execPath}\n${scriptBody}\n`, "utf8");
  await chmod(scriptPath, 0o755);
  try {
    return await fn(scriptPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("parseAntigravityJsonlEvent handles init, deltas, tools, thinking, keepalive, and results", () => {
  assert.deepEqual(
    parseAntigravityJsonlEvent(JSON.stringify({ event: "init", conversation_id: "conv-1" })),
    { kind: "sessionId", sessionId: "conv-1" },
  );
  assert.deepEqual(
    parseAntigravityJsonlEvent(JSON.stringify({ event: "init", conversation_id: "" })),
    [],
  );

  assert.deepEqual(
    parseAntigravityJsonlEvent(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "Hello" },
      }),
    ),
    [{ kind: "text", text: "Hello" }],
  );

  assert.deepEqual(
    parseAntigravityJsonlEvent(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "agent_response", text_delta: "" },
      }),
    ),
    [{ kind: "thinking", text: "…\n" }],
  );

  assert.deepEqual(
    parseAntigravityJsonlEvent(
      JSON.stringify({
        event: "step_update",
        step_update: { step_type: "checkpoint" },
      }),
    ),
    [{ kind: "thinking", text: "… checkpoint\n" }],
  );

  assert.deepEqual(
    parseAntigravityJsonlEvent(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          step_index: 2,
          conversation_id: "conv-1",
          tool_name: "view_file",
          state: "RUNNING",
          tool_info: { parameters: { path: "/tmp/a" } },
        },
      }),
    ),
    [
      {
        kind: "toolStart",
        toolCallId: "agy:conv-1:2",
        name: "view_file",
        args: { path: "/tmp/a" },
      },
      { kind: "thinking", text: "▸ view_file\n" },
    ],
  );

  assert.deepEqual(
    parseAntigravityJsonlEvent(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          step_index: 2,
          conversation_id: "conv-1",
          tool_name: "view_file",
          state: "DONE",
          tool_info: { parameters: { path: "/tmp/a" }, output: "ok" },
        },
      }),
    ),
    [
      {
        kind: "toolStart",
        toolCallId: "agy:conv-1:2",
        name: "view_file",
        args: { path: "/tmp/a" },
      },
      {
        kind: "toolResult",
        toolCallId: "agy:conv-1:2",
        name: "view_file",
        isError: false,
        result: "ok",
      },
      { kind: "thinking", text: "▸ view_file ✓\n" },
    ],
  );

  assert.deepEqual(
    parseAntigravityJsonlEvent(
      JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "tool",
          step_index: 3,
          conversation_id: "conv-1",
          tool_name: "run_command",
          state: "FAILED",
          tool_info: { parameters: {}, error: "boom" },
        },
      }),
    ),
    [
      {
        kind: "toolStart",
        toolCallId: "agy:conv-1:3",
        name: "run_command",
        args: {},
      },
      {
        kind: "toolResult",
        toolCallId: "agy:conv-1:3",
        name: "run_command",
        isError: true,
        result: "boom",
      },
      { kind: "thinking", text: "▸ run_command ✗\n" },
    ],
  );

  assert.deepEqual(
    parseAntigravityJsonlEvent(JSON.stringify({ event: "openclaw_keepalive", elapsed_seconds: 90 })),
    { kind: "thinking", text: "… still working (90s without output)\n" },
  );

  assert.deepEqual(
    parseAntigravityJsonlEvent(
      JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          conversation_id: "conv-1",
          response: "done",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 2,
            total_tokens: 17,
          },
        },
      }),
    ),
    {
      kind: "result",
      sessionId: "conv-1",
      text: "done",
      usage: { input: 10, output: 5, cacheRead: 2, total: 17 },
    },
  );

  const errResult = parseAntigravityJsonlEvent(
    JSON.stringify({
      event: "result",
      result: { status: "FAILED", error: "bad request" },
    }),
  );
  assert.equal(errResult.kind, "result");
  assert.match(errResult.errorText, /FAILED.*bad request/);

  assert.throws(() => parseAntigravityJsonlEvent("{bad"), SyntaxError);
  assert.throws(() => parseAntigravityJsonlEvent(JSON.stringify({ foo: 1 })), /envelope/);
  assert.throws(
    () => parseAntigravityJsonlEvent(JSON.stringify({ event: "result", result: {} })),
    /status/,
  );
});

test("normalizeAgyArgs strips prompt/format flags, rewrites --resume to --conversation, and pins stream-json", () => {
  assert.deepEqual(
    normalizeAgyArgs([
      "--print",
      "{prompt}",
      "-p",
      "hello",
      "--prompt=ignored",
      "--input-format",
      "text",
      "--output-format=json",
      "--mode",
      "accept-edits",
      "--resume",
      "conv-42",
      "--disable-slash-commands",
    ]),
    [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--mode",
      "accept-edits",
      "--conversation",
      "conv-42",
      "--disable-slash-commands",
    ],
  );

  assert.deepEqual(
    normalizeAgyArgs(["--resume=conv-9", "--conversation", "conv-existing"]),
    [
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--conversation",
      "conv-existing",
    ],
  );
});

test("composeAgyPrompt and agyUserMessage format messages cleanly", () => {
  const composed = composeAgyPrompt({
    systemPrompt: "SYS",
    promptContext: { prependContext: "PRE", appendContext: "APP" },
    prompt: "USR",
  });
  assert.equal(composed, "SYS\n\nPRE\n\nUSR\n\nAPP");

  const side = composeAgyPrompt({
    executionMode: "side-question",
    systemPrompt: "SYS",
    prompt: "USR",
  });
  assert.equal(side, "USR");
  assert.deepEqual(JSON.parse(agyUserMessage("hi")), {
    event: "user",
    message: { content: "hi" },
  });
});

test("createTurnAccumulator isolates step usage on resume and clears false-positive error", () => {
  const acc = createTurnAccumulator({ useResume: true });
  acc.observe({
    event: "step_update",
    step_update: {
      step_type: "agent_response",
      step_index: 5,
      state: "DONE",
      usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 },
    },
  });
  const finalized = acc.finalizeResult(
    {
      event: "result",
      result: {
        status: "FAILED",
        error: "stale retry step error",
        response: "final answer",
        usage: { input_tokens: 999, output_tokens: 999, total_tokens: 1998 },
      },
    },
    { exitCode: 0 },
  );
  assert.equal(finalized.is_error, false);
  assert.equal(finalized.result.status, "SUCCESS");
  assert.deepEqual(finalized.result.usage, {
    input_tokens: 11,
    output_tokens: 4,
    total_tokens: 15,
    contextUsage: { state: "available", promptTokens: 11, totalTokens: 15 },
  });
});

test("createKeepalive emits ticks only while silent within maxSilentMs", async () => {
  const ticks = [];
  const ka = createKeepalive({
    intervalMs: 25,
    maxSilentMs: 90,
    onTick: (elapsed) => ticks.push(elapsed),
  });
  try {
    await new Promise((r) => setTimeout(r, 130));
  } finally {
    ka.stop();
  }
  assert.ok(ticks.length >= 1, "expected at least one keepalive tick");
  assert.ok(ticks.length <= 4, `expected ticks to stop after maxSilentMs, got ${ticks.length}`);
});

test("syntheticInterruptResult includes conversation_id when provided", () => {
  assert.deepEqual(syntheticInterruptResult(), {
    event: "result",
    type: "result",
    is_error: false,
    result: { status: "SUCCESS", response: "" },
  });
  assert.deepEqual(syntheticInterruptResult("conv-77"), {
    event: "result",
    type: "result",
    is_error: false,
    result: { status: "SUCCESS", response: "", conversation_id: "conv-77" },
  });
});

test("executeAntigravityStream streams events from fake node CLI and handles status & interrupt", async () => {
  await withFakeCli(
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const msg = JSON.parse(line);
      process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-fake-1" }) + "\\n");
      process.stdout.write(JSON.stringify({
        event: "step_update",
        step_update: {
          step_type: "agent_response",
          step_index: 1,
          state: "DONE",
          text_delta: "Echo:" + msg.message.content,
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", conversation_id: "conv-fake-1", response: "Echo:" + msg.message.content },
      }) + "\\n");
      process.exit(0);
    });
    `,
    async (cliPath, cwd) => {
      let statusHandle;
      let activeState;
      const events = [];
      for await (const ev of executeAntigravityStream({
        command: cliPath,
        args: ["--print", "{prompt}", "--resume", "conv-0"],
        cwd,
        env: process.env,
        prompt: "ping",
        registerTurnStatus: (adapter) => {
          statusHandle = adapter.capture();
        },
      })) {
        events.push(ev);
        if (ev.event === "init") {
          activeState = await statusHandle.assess();
        }
      }
      assert.equal(activeState.state, "unknown");
      assert.equal(activeState.basis, "process_present");
      assert.equal(events[0].event, "init");
      assert.equal(events[1].step_update.text_delta, "Echo:ping");
      assert.equal(events[2].type, "result");
      assert.equal(events[2].result.response, "Echo:ping");
      const postAssess = await statusHandle.assess();
      assert.equal(postAssess.state, "unknown");
      assert.equal(postAssess.basis, "status_unsupported");
    },
  );

  // Interrupt test
  await withFakeCli(
    `
    import { createInterface } from "node:readline";
    const rl = createInterface({ input: process.stdin });
    rl.on("line", () => {
      process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-int" }) + "\\n");
    });
    setInterval(() => {}, 1000);
    `,
    async (cliPath, cwd) => {
      let interruptFn;
      const events = [];
      for await (const ev of executeAntigravityStream({
        command: cliPath,
        args: [],
        cwd,
        env: process.env,
        prompt: "hang",
        registerTurnInterrupt: (ctrl) => {
          interruptFn = ctrl.interrupt;
        },
      })) {
        events.push(ev);
        if (ev.event === "init") {
          await interruptFn();
        }
      }
      const last = events.at(-1);
      assert.equal(last.event, "result");
      assert.equal(last.is_error, false);
    },
  );
});
