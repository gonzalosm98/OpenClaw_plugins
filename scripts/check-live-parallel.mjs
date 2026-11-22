#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAntigravityCommandEnv,
  buildBaseArgs,
  resolveAntigravityCommand,
} from "../src/cli-backend.js";
import { createSemaphore } from "../src/concurrency.js";
import { executeAntigravityLiveTurn } from "../src/live-session.js";
import { prepareAgyMcpIsolation } from "../src/mcp-isolation.js";
import { executeAntigravityStream } from "../src/stream.js";

function createMockMcpServer(expectedToken, markerValue) {
  const seenTokens = [];
  const seenMethods = [];
  const server = createServer(async (req, res) => {
    const auth = req.headers.authorization;
    if (auth) seenTokens.push(auth);
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (auth !== `Bearer ${expectedToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    seenMethods.push(body.method);
    if (body.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result = {};
    if (body.method === "initialize") {
      result = {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "mock-mcp", version: "1.0.0" },
      };
    } else if (body.method === "tools/list") {
      result = {
        tools: [
          {
            name: "get_isolation_marker",
            description: "Returns the isolated MCP server marker string.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    } else if (body.method === "tools/call") {
      result = {
        content: [{ type: "text", text: markerValue }],
      };
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Mcp-Session-Id": `session-${markerValue}`,
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  return {
    seenTokens,
    seenMethods,
    async listen() {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      return `http://127.0.0.1:${addr.port}/mcp`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function snapshotFile(path) {
  try {
    const [info, content] = await Promise.all([stat(path), readFile(path, "utf8")]);
    return { exists: true, mtimeMs: info.mtimeMs, content };
  } catch {
    return { exists: false };
  }
}

async function runParallelMcpTest(tempRoot, command, env) {
  const globalMcpPath = join(env.HOME || homedir(), ".gemini", "config", "mcp_config.json");
  const beforeGlobal = await snapshotFile(globalMcpPath);

  const tokenA = `tok-alpha-${randomUUID()}`;
  const tokenB = `tok-beta-${randomUUID()}`;
  const markerA = `MARKER_ALPHA_${randomUUID().slice(0, 8)}`;
  const markerB = `MARKER_BETA_${randomUUID().slice(0, 8)}`;

  const serverA = createMockMcpServer(tokenA, markerA);
  const serverB = createMockMcpServer(tokenB, markerB);
  const urlA = await serverA.listen();
  const urlB = await serverB.listen();

  const mcpFileA = join(tempRoot, "mcp-a.json");
  const mcpFileB = join(tempRoot, "mcp-b.json");
  await writeFile(
    mcpFileA,
    JSON.stringify({
      mcpServers: {
        mock_isolated: { url: urlA, headers: { Authorization: `Bearer ${tokenA}` } },
      },
    }),
  );
  await writeFile(
    mcpFileB,
    JSON.stringify({
      mcpServers: {
        mock_isolated: { url: urlB, headers: { Authorization: `Bearer ${tokenB}` } },
      },
    }),
  );

  const cwdA = join(tempRoot, "cwd-a");
  const cwdB = join(tempRoot, "cwd-b");
  const baseArgs = [
    ...buildBaseArgs({ mode: "accept-edits", skipPermissions: true }),
    "--model",
    "gemini-3.8-flash",
    "--effort",
    "low",
  ];

  const runOne = async (mcpFile, cwd, label) => {
    const iso = await prepareAgyMcpIsolation({
      args: [...baseArgs, "--strict-mcp-config", "--mcp-config", mcpFile],
      env,
    });
    const startedAt = Date.now();
    let resultEvent;
    try {
      for await (const ev of executeAntigravityStream({
        command,
        args: iso.args,
        cwd,
        env,
        prompt: `Call the MCP tool get_isolation_marker and reply with ONLY its exact output string. (${label})`,
      })) {
        if (ev.event === "result") resultEvent = ev;
      }
    } finally {
      await iso.cleanup();
    }
    return { startedAt, endedAt: Date.now(), resultEvent };
  };

  try {
    await Promise.all([
      import("node:fs/promises").then((fs) => fs.mkdir(cwdA, { recursive: true })),
      import("node:fs/promises").then((fs) => fs.mkdir(cwdB, { recursive: true })),
    ]);

    const [resA, resB] = await Promise.all([
      runOne(mcpFileA, cwdA, "run-A"),
      runOne(mcpFileB, cwdB, "run-B"),
    ]);

    assert.equal(resA.resultEvent?.is_error, false, `Run A failed: ${JSON.stringify(resA.resultEvent)}`);
    assert.equal(resB.resultEvent?.is_error, false, `Run B failed: ${JSON.stringify(resB.resultEvent)}`);
    assert.ok(
      resA.resultEvent?.result?.response?.includes(markerA),
      `Run A response did not include markerA (${markerA}): ${resA.resultEvent?.result?.response}`,
    );
    assert.ok(
      resB.resultEvent?.result?.response?.includes(markerB),
      `Run B response did not include markerB (${markerB}): ${resB.resultEvent?.result?.response}`,
    );
    assert.ok(
      serverA.seenTokens.every((t) => t === `Bearer ${tokenA}`) && serverA.seenTokens.length > 0,
      `Server A saw unexpected tokens: ${JSON.stringify(serverA.seenTokens)}`,
    );
    assert.ok(
      serverB.seenTokens.every((t) => t === `Bearer ${tokenB}`) && serverB.seenTokens.length > 0,
      `Server B saw unexpected tokens: ${JSON.stringify(serverB.seenTokens)}`,
    );

    const afterGlobal = await snapshotFile(globalMcpPath);
    assert.deepEqual(afterGlobal, beforeGlobal, "Global ~/.gemini/config/mcp_config.json was modified!");

    return {
      runAMs: resA.endedAt - resA.startedAt,
      runBMs: resB.endedAt - resB.startedAt,
      serverAMethods: serverA.seenMethods,
      serverBMethods: serverB.seenMethods,
      globalMcpUntouched: true,
    };
  } finally {
    await Promise.all([serverA.close(), serverB.close()]);
  }
}

function createLiveCapability() {
  let currentHandle;
  const handles = new Set();
  return {
    fingerprint: "live-parallel-check",
    register: (h) => handles.add(h),
    current: () => currentHandle,
    activate: (h) => {
      currentHandle = h;
    },
    remove: (h) => {
      handles.delete(h);
      if (currentHandle === h) currentHandle = undefined;
    },
    restart: async () => {
      const h = currentHandle;
      currentHandle = undefined;
      for (const handle of [...handles]) {
        handle.close("cleanup");
        await handle.waitForExit();
      }
      if (h) {
        h.close("cleanup");
        await h.waitForExit();
      }
    },
  };
}

async function runWarmLiveSessionTest(tempRoot, command, env) {
  const cwd = join(tempRoot, "live-cwd");
  await import("node:fs/promises").then((fs) => fs.mkdir(cwd, { recursive: true }));
  const semaphore = createSemaphore(2);
  const liveSession = createLiveCapability();
  const secret = `ORCHARD-${randomUUID().slice(0, 8)}`;
  const pids = [];
  const baseArgs = [
    ...buildBaseArgs({ mode: "accept-edits", skipPermissions: true }),
    "--model",
    "gemini-3.8-flash",
    "--effort",
    "low",
  ];

  try {
    let convId;
    let turn1Result;
    for await (const ev of executeAntigravityLiveTurn(
      {
        command,
        args: baseArgs,
        cwd,
        env,
        prompt: `Remember this exact secret code word: ${secret}. Reply with ONLY the word STORED.`,
        liveSession,
        onSpawn: (child) => pids.push(child.pid),
      },
      { semaphore, idleTimeoutMs: 60_000 },
    )) {
      if (ev.event === "init" && ev.conversation_id) convId = ev.conversation_id;
      if (ev.event === "result") turn1Result = ev;
    }

    assert.equal(turn1Result?.is_error, false, "Warm Turn 1 failed");
    assert.ok(convId, "Warm Turn 1 did not yield conversation_id");

    let turn2Result;
    for await (const ev of executeAntigravityLiveTurn(
      {
        command,
        args: [...baseArgs, "--resume", convId],
        cwd,
        env,
        prompt: "What exact secret code word did I ask you to remember? Reply with ONLY that code word.",
        liveSession,
        onSpawn: (child) => pids.push(child.pid),
      },
      { semaphore, idleTimeoutMs: 60_000 },
    )) {
      if (ev.event === "result") turn2Result = ev;
    }

    assert.equal(pids.length, 1, `Expected 1 spawned process across 2 warm turns, got ${pids.length}`);
    assert.equal(turn2Result?.is_error, false, "Warm Turn 2 failed");
    assert.ok(
      turn2Result?.result?.response?.includes(secret),
      `Warm Turn 2 did not recall secret (${secret}): ${turn2Result?.result?.response}`,
    );

    return {
      pid: pids[0],
      conversationId: convId,
      turn1Response: turn1Result.result.response.trim(),
      turn2Response: turn2Result.result.response.trim(),
    };
  } finally {
    await liveSession.restart();
  }
}

export async function runLiveParallelCheck() {
  const env = buildAntigravityCommandEnv();
  const command = resolveAntigravityCommand(undefined, env);
  const tempRoot = await mkdtemp(join(tmpdir(), "agy-live-parallel-"));
  try {
    const testA = await runParallelMcpTest(tempRoot, command, env);
    const testB = await runWarmLiveSessionTest(tempRoot, command, env);
    return { ok: true, testA, testB };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runLiveParallelCheck()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
