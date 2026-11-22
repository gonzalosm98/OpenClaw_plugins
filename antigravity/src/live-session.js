// Warm agy live sessions (one long-lived `agy --input-format stream-json` process
// per OpenClaw conversation).
//
// Structure mirrors the host's Claude CLI live-session runtime
// (`extensions/anthropic/cli.runtime.js`): the host owns a per-owner session
// handle through `context.liveSession`; this module owns the process behind it.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { prepareAgyMcpIsolation } from "./mcp-isolation.js";
import {
  agyUserMessage,
  composeAgyPrompt,
  createAsyncQueue,
  createKeepalive,
  createTurnAccumulator,
  createTurnStatus,
  killProcessTree,
  normalizeAgyArgs,
  syntheticInterruptResult,
} from "./stream.js";

const MAX_LINE_CHARS = 1_048_576;
const STDERR_TAIL_CHARS = 16_384;

/** @type {WeakMap<object, any>} handle → session */
const sessions = new WeakMap();

export const __testing = { sessions };

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toError(value, fallback) {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value) return new Error(value);
  return new Error(fallback);
}

function armIdleTimer(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => session.handle.close("idle"), session.deps.idleTimeoutMs ?? 600_000);
  session.idleTimer.unref?.();
}

/** Called once the process is gone (or was never started on a closed session). */
function onProcessGone(session) {
  if (session.gone) return;
  session.gone = true;
  clearTimeout(session.killTimer);
  session.resolveExit();
  const mcp = session.mcp;
  session.mcp = undefined;
  void mcp?.cleanup();
}

function terminateProcess(session) {
  const child = session.child;
  if (!child) {
    if (!session.starting) onProcessGone(session);
    return;
  }
  if (session.gone) return;
  try { child.stdin?.end(); } catch { /* already closed */ }
  try { killProcessTree(child, "SIGTERM"); } catch { /* already gone */ }
  if (!session.killTimer) {
    session.killTimer = setTimeout(() => {
      if (!session.gone) {
        try { killProcessTree(child, "SIGKILL"); } catch { /* already gone */ }
      }
    }, 1_000);
    session.killTimer.unref?.();
  }
}

function closeSession(session, error) {
  if (session.closed) return;
  session.closed = true;
  clearTimeout(session.idleTimer);
  session.capability?.remove(session.handle);
  const turn = session.currentTurn;
  session.currentTurn = undefined;
  if (turn) {
    turn.error = toError(error, "Antigravity live session closed.");
    turn.keepalive?.stop();
    turn.queue.end();
  }
  terminateProcess(session);
}

function completeTurn(session, turn) {
  if (session.currentTurn === turn) session.currentTurn = undefined;
  turn.keepalive?.stop();
  turn.queue.end();
  if (!session.closed) armIdleTimer(session);
}

function createSession(capability, deps) {
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const session = {
    capability,
    deps,
    closed: false,
    gone: false,
    starting: false,
    conversationId: undefined,
    stderr: "",
    resolveExit,
    handle: {
      generation: randomUUID(),
      fingerprint: capability?.fingerprint ?? randomUUID(),
      isIdle: () => !session.closed && !session.currentTurn,
      close: (_reason, error) => closeSession(session, error),
      waitForExit: async () => {
        if (!session.child && !session.starting) return;
        await exited;
      },
    },
  };
  sessions.set(session.handle, session);
  capability?.register(session.handle);
  return session;
}

function handleStdoutLine(session, line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return; // Non-JSON noise on stdout is ignored.
  }
  if (!record(value) || typeof value.event !== "string") return;
  const step = value.step_update;
  const found = value.event === "init" ? value.conversation_id
    : value.event === "step_update" && record(step) ? step.conversation_id
      : value.event === "result" && record(value.result) ? value.result.conversation_id
        : undefined;
  if (typeof found === "string" && found) session.conversationId = found;
  const turn = session.currentTurn;
  if (!turn) return;
  turn.keepalive?.touch();
  turn.accumulator.observe(value);
  if (value.event === "result") {
    let terminal;
    try {
      terminal = turn.accumulator.finalizeResult(value);
    } catch (error) {
      closeSession(session, error);
      return;
    }
    turn.terminal = true;
    turn.queue.push(terminal);
    completeTurn(session, turn);
    return;
  }
  turn.queue.push(value);
}

async function startProcess(session, context, deps) {
  session.starting = true;
  let child;
  try {
    const normalized = normalizeAgyArgs(context.args);
    const iso = await prepareAgyMcpIsolation({
      args: normalized,
      env: context.env,
      toolAvailability: context.toolAvailability,
      mcpTimeoutSeconds: deps.mcpTimeoutSeconds ?? 600,
    });
    session.mcp = iso;
    if (session.closed) {
      throw session.currentTurn?.error ?? new Error("Antigravity live session closed during startup.");
    }
    child = (deps.spawnImpl ?? spawn)(context.command, iso.args, {
      cwd: context.cwd, env: context.env, argv0: context.argv0,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    session.starting = false;
    if (!session.child) onProcessGone(session);
    throw error;
  }
  session.child = child;
  session.starting = false;
  context.onSpawn?.(child);
  child.stdin.on("error", () => {}); // The exit handler reports the failure.
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    session.stderr = (session.stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  child.stdout.setEncoding("utf8");
  let pending = "";
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) handleStdoutLine(session, line);
    }
    if (pending.length > MAX_LINE_CHARS) {
      pending = "";
      closeSession(session, new Error("AGY stream record exceeds the line limit."));
    }
  });
  let settled = false;
  const settle = (code, signal, spawnError) => {
    if (settled) return;
    settled = true;
    if (pending.trim()) handleStdoutLine(session, pending.trim());
    pending = "";
    const detail = session.stderr.trim();
    const error = spawnError ?? new Error(
      `AGY live process exited with code ${code ?? signal}${detail ? `: ${detail}` : "."}`,
    );
    // During a turn this fails it; outside a turn it only retires the session.
    closeSession(session, session.currentTurn ? error : undefined);
    onProcessGone(session);
  };
  child.once("error", (error) => {
    if (!child.pid) setImmediate(() => settle(null, null, error));
    else closeSession(session, error);
  });
  child.once("close", (code, signal) => settle(code, signal));
}

/**
 * Runs one turn on the conversation's warm agy process (starting it if needed).
 *
 * @param {object} context host execute context (with `liveSession`)
 * @param {{
 *   semaphore: { acquire(signal?: AbortSignal): Promise<() => void> },
 *   idleTimeoutMs?: number,
 *   maxSilentMs?: number,
 *   keepaliveIntervalMs?: number,
 *   mcpTimeoutSeconds?: number,
 *   spawnImpl?: typeof spawn,
 * }} deps
 */
export async function* executeAntigravityLiveTurn(context, deps) {
  context.assertCurrent?.();
  context.abortSignal?.throwIfAborted();
  const live = context.liveSession;
  const existing = live.current();
  let session = existing && existing.fingerprint === live.fingerprint ? sessions.get(existing) : undefined;
  if (!session || session.closed) {
    await live.restart();
    context.assertCurrent?.();
    session = createSession(live, deps);
  }
  session.capability = live;
  session.deps = deps;
  if (session.currentTurn) {
    throw new Error("Antigravity live session is already handling another turn.");
  }
  clearTimeout(session.idleTimer);
  const turn = {
    context,
    queue: createAsyncQueue(),
    accumulator: undefined,
    keepalive: undefined,
    error: undefined,
    terminal: false,
    interrupted: false,
  };
  session.currentTurn = turn;
  const abort = () => session.handle.close("abort", context.abortSignal?.reason);
  context.abortSignal?.addEventListener("abort", abort, { once: true });
  let release;
  try {
    release = await deps.semaphore.acquire(context.abortSignal);
    context.abortSignal?.throwIfAborted();
    context.assertCurrent?.();
    if (session.closed || session.currentTurn !== turn) {
      throw turn.error ?? new Error("Antigravity live session closed before its prompt was accepted.");
    }
    const firstTurnOfProcess = !session.child;
    turn.accumulator = createTurnAccumulator(context, { reusedProcess: !firstTurnOfProcess });
    live.activate(session.handle);
    if (firstTurnOfProcess) await startProcess(session, context, deps);
    context.assertCurrent?.();
    if (session.closed || session.currentTurn !== turn) {
      throw turn.error ?? new Error("Antigravity live session closed before its prompt was accepted.");
    }
    const generation = session.handle.generation;
    context.registerTurnStatus?.(createTurnStatus(context, {
      isClosed: () => session.closed,
      isCurrent: () => session.handle.generation === generation && !turn.interrupted &&
        (session.currentTurn === turn || (session.closed && turn.error !== undefined)),
    }));
    context.registerTurnInterrupt?.({
      async interrupt() {
        context.assertCurrent?.();
        if (session.currentTurn !== turn && turn.terminal) return;
        if (session.closed || session.currentTurn !== turn) {
          throw new Error("The Antigravity live turn is no longer active.");
        }
        turn.interrupted = true;
        turn.terminal = true;
        turn.queue.push(syntheticInterruptResult(session.conversationId));
        completeTurn(session, turn);
        // agy has no mid-turn cancel: recycle the process; the next turn resumes
        // the conversation with `--conversation`.
        session.handle.close("idle");
        await session.handle.waitForExit();
      },
    });
    turn.keepalive = createKeepalive({
      intervalMs: deps.keepaliveIntervalMs ?? context.keepaliveIntervalMs ?? 90_000,
      maxSilentMs: deps.maxSilentMs ?? (context.maxSilentThinkingSeconds ?? 720) * 1000,
      onTick: (elapsed) => turn.queue.push({ event: "openclaw_keepalive", elapsed_seconds: elapsed }),
    });
    if (!firstTurnOfProcess && session.conversationId) {
      turn.queue.push({
        event: "init",
        type: "system",
        subtype: "init",
        conversation_id: session.conversationId,
      });
    }
    const prompt = composeAgyPrompt(context, { includeSystemPrompt: firstTurnOfProcess });
    session.child.stdin.write(agyUserMessage(prompt));
    for await (const item of turn.queue) {
      context.assertCurrent?.();
      yield item;
    }
    if (turn.error) throw turn.error;
    if (!turn.terminal) throw new Error("AGY live turn ended without a terminal result.");
  } catch (error) {
    if (session.currentTurn === turn) session.handle.close("abort", error);
    throw turn.error ?? error;
  } finally {
    context.abortSignal?.removeEventListener("abort", abort);
    turn.keepalive?.stop();
    release?.();
    if (session.currentTurn === turn) {
      // Abnormal exit (consumer stopped early, setup failure): retire the process.
      session.handle.close("abort");
    }
    if (session.closed) await session.handle.waitForExit();
  }
}
