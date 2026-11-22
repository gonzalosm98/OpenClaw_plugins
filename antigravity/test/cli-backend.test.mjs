import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAntigravityCliBackend, buildBaseArgs } from "../src/cli-backend.js";
import { createAntigravityCompletionStream } from "../src/completion.js";
import {
  ANTIGRAVITY_MODEL_ALIASES,
  ANTIGRAVITY_MODEL_IDS,
  buildAntigravityModelCatalog,
  resolveAntigravityEffort,
  resolveAntigravityTransportModelId,
} from "../src/models.js";

test("buildBaseArgs and buildAntigravityCliBackend expose Phase 1 + Phase 2 configuration", () => {
  assert.deepEqual(buildBaseArgs(), [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--mode",
    "accept-edits",
    "--disable-slash-commands",
  ]);
  assert.deepEqual(buildBaseArgs({ mode: "none", skipPermissions: true }), [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
  ]);

  const backend = buildAntigravityCliBackend({ mode: "auto" });
  assert.equal(backend.bundleMcp, true);
  assert.equal(backend.bundleMcpMode, "claude-config-file");
  assert.equal(backend.config.input, "stdin");
  assert.equal(backend.config.output, "jsonl");
  assert.equal(backend.config.resumeOutput, "jsonl");
  assert.equal(backend.config.liveSession, "claude-stdio");
  assert.equal(backend.config.serialize, false);
  assert.equal(backend.config.imagePathScope, "workspace");
  assert.deepEqual(backend.config.args, [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--mode",
    "auto",
    "--disable-slash-commands",
  ]);
  assert.deepEqual(backend.config.resumeArgs, [...backend.config.args, "--resume", "{sessionId}"]);
  assert.deepEqual(backend.config.reliability, {
    watchdog: {
      fresh: { noOutputTimeoutRatio: 0.9, minMs: 300_000, maxMs: 900_000 },
      resume: { noOutputTimeoutRatio: 0.9, minMs: 300_000, maxMs: 900_000 },
    },
  });

  const disabledLive = buildAntigravityCliBackend({ liveSession: false });
  assert.equal(disabledLive.config.liveSession, undefined);
});

test("resolveExecutionArgs handles side-question and --effort resolution", () => {
  const backend = buildAntigravityCliBackend();
  const neonArgs = backend.resolveExecutionArgs({
    baseArgs: backend.config.args,
    controlOperation: "compact",
    modelId: "gemini-4-neon",
    thinkingLevel: "xhigh",
  });
  assert.ok(neonArgs.includes("--disable-slash-commands"));
  assert.deepEqual(neonArgs.slice(-2), ["--effort", "xhigh"]);

  const sideArgs = backend.resolveExecutionArgs({
    baseArgs: backend.config.args,
    executionMode: "side-question",
    modelId: "gemini-3.8-flash",
    thinkingLevel: "low",
  });
  assert.ok(sideArgs.includes("--disable-slash-commands"));
  assert.deepEqual(sideArgs.slice(-4), [
    "--effort",
    "low",
    "--agent",
    "openclaw-antigravity-setup",
  ]);
});

test("models.js supports gemini-4-neon, orchestrators, xhigh, and aliases", () => {
  assert.equal(ANTIGRAVITY_MODEL_IDS.length, 9);
  assert.ok(ANTIGRAVITY_MODEL_IDS.includes("gemini-4-neon"));
  assert.ok(ANTIGRAVITY_MODEL_IDS.includes("gemini-pro-orchestrator-neon"));
  assert.ok(ANTIGRAVITY_MODEL_IDS.includes("gemini-pro-orchestrator-g1-pro"));
  assert.equal(ANTIGRAVITY_MODEL_ALIASES.neon, "gemini-4-neon");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES.hydrogen, "gemini-4-hydrogen");
  assert.equal(ANTIGRAVITY_MODEL_ALIASES.argon, "gemini-4-argon");
  assert.equal(resolveAntigravityTransportModelId("neon"), "gemini-4-neon");
  assert.equal(resolveAntigravityTransportModelId("claude-opus-4-6"), "claude-opus-4-6-thinking");
  assert.equal(resolveAntigravityEffort("gemini-4-neon", "xhigh"), "xhigh");
  assert.equal(resolveAntigravityEffort("gemini-3.8-flash", "xhigh"), "high");

  const catalog = buildAntigravityModelCatalog();
  assert.equal(catalog.length, 9);
  const neon = catalog.find((entry) => entry.id === "gemini-4-neon");
  assert.ok(neon);
  assert.equal(neon.name, "Gemini 4 Neon");
  assert.equal(neon.reasoning, true);
  assert.deepEqual(neon.input, ["text", "image"]);

  const orchestrator = catalog.find((entry) => entry.id === "gemini-pro-orchestrator-neon");
  assert.ok(orchestrator);
  assert.equal(orchestrator.reasoning, false);
  assert.deepEqual(orchestrator.input, ["text", "image"]);
});

test("prepareExecution.execute routes one-shot and live turns cleanly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-backend-exec-"));
  const cliPath = join(dir, "fake-agy.mjs");
  const mcpPath = join(dir, "mcp.json");
  await writeFile(
    mcpPath,
    JSON.stringify({ mcpServers: { demo: { url: "http://127.0.0.1:9999/mcp" } } }),
  );
  await writeFile(
    cliPath,
    `#!${process.execPath}
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const addDirIdx = args.indexOf("--add-dir");
const hasMcp = addDirIdx >= 0 && existsSync(join(args[addDirIdx + 1], ".agents", "mcp_config.json"));
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  process.stdout.write(JSON.stringify({ event: "init", conversation_id: "conv-b1" }) + "\\n");
  process.stdout.write(JSON.stringify({
    event: "result",
    result: { status: "SUCCESS", conversation_id: "conv-b1", response: hasMcp + ":" + msg.message.content },
  }) + "\\n");
  process.exit(0);
});
`,
  );
  await chmod(cliPath, 0o755);

  try {
    const backend = buildAntigravityCliBackend();
    const prepared = backend.prepareExecution({});
    const events = [];
    for await (const ev of prepared.execute({
      command: cliPath,
      args: [...backend.config.args, "--strict-mcp-config", "--mcp-config", mcpPath],
      cwd: dir,
      env: process.env,
      prompt: "ok",
    })) {
      events.push(ev);
    }
    assert.equal(events.at(-1).result.response, "true:ok");

    // Live turn routing via prepareExecution
    let liveHandle;
    const liveCap = {
      fingerprint: "fp-cb",
      register: () => {},
      current: () => liveHandle,
      activate: (h) => {
        liveHandle = h;
      },
      remove: (h) => {
        if (liveHandle === h) liveHandle = undefined;
      },
      restart: async () => {
        const h = liveHandle;
        liveHandle = undefined;
        if (h) {
          h.close("restart");
          await h.waitForExit();
        }
      },
    };
    const liveEvents = [];
    for await (const ev of prepared.execute({
      command: cliPath,
      args: [...backend.config.args],
      cwd: dir,
      env: process.env,
      prompt: "live-ok",
      liveSession: liveCap,
    })) {
      liveEvents.push(ev);
    }
    assert.equal(liveEvents.at(-1).result.response, "false:live-ok");
    await liveCap.restart();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAntigravityCompletionStream smoke test with mocked executor", async () => {
  let capturedCall;
  const mockExecute = async function* (ctx) {
    capturedCall = ctx;
    yield { event: "init", conversation_id: "conv-comp" };
    yield {
      event: "result",
      type: "result",
      is_error: false,
      result: {
        status: "SUCCESS",
        conversation_id: "conv-comp",
        response: "Verified reply",
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      },
    };
  };

  const streamFn = createAntigravityCompletionStream({}, undefined, mockExecute);
  const stream = streamFn(
    { id: "gemini-3.8-flash", api: "pi-messages", provider: "antigravity-cli" },
    { systemPrompt: "Be brief", messages: [{ role: "user", content: "Say hi" }] },
    { reasoning: "low" },
  );

  const emitted = [];
  for await (const ev of stream) {
    emitted.push(ev);
  }
  const finalMsg = await stream.result();
  assert.equal(capturedCall.executionMode, "side-question");
  assert.ok(capturedCall.args.includes("--agent"));
  assert.ok(capturedCall.args.includes("openclaw-antigravity-setup"));
  assert.ok(emitted.some((e) => e.type === "text_delta" && e.delta === "Verified reply"));
  assert.equal(finalMsg.stopReason, "stop");
  assert.equal(finalMsg.usage.totalTokens, 15);
});
