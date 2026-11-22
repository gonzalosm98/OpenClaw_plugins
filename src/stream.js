import { spawn } from "node:child_process";
import { join } from "node:path";

const MAX_LINE_CHARS = 1_048_576;
const STDERR_TAIL_CHARS = 16_384;
export const MAX_PROMPT_ARG_BYTES = 96_000;
// Retain the host's character preflight cap; native execution also checks bytes.
export const MAX_PROMPT_ARG_CHARS = MAX_PROMPT_ARG_BYTES;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decode(line) {
  const value = JSON.parse(line);
  if (!record(value) || typeof value.event !== "string") {
    throw new Error("Invalid AGY stream event envelope.");
  }
  return value;
}

const USAGE_FIELDS = [
  ["input_tokens", "input"],
  ["output_tokens", "output"],
  ["thinking_tokens", "reasoningTokens"],
  ["cache_read_tokens", "cacheRead"],
  ["total_tokens", "total"],
];

function contextUsageFrom(value) {
  if (!record(value) || value.state !== "available") return undefined;
  const promptTokens = Number.isFinite(value.promptTokens) && value.promptTokens >= 0
    ? Math.trunc(value.promptTokens)
    : undefined;
  const totalTokens = Number.isFinite(value.totalTokens) && value.totalTokens >= 0
    ? Math.trunc(value.totalTokens)
    : undefined;
  if (promptTokens === undefined || totalTokens === undefined || totalTokens < promptTokens) {
    return undefined;
  }
  return { state: "available", promptTokens, totalTokens };
}

function usageFrom(value) {
  if (!record(value)) return undefined;
  const usage = {};
  for (const [source, target] of USAGE_FIELDS) {
    if (Number.isFinite(value[source]) && value[source] >= 0) usage[target] = value[source];
  }
  const contextUsage = contextUsageFrom(value.contextUsage ?? value.context_usage);
  if (contextUsage) usage.contextUsage = contextUsage;
  return Object.keys(usage).length ? usage : undefined;
}

function lastStepContextUsage(stepUsage) {
  if (!record(stepUsage)) return undefined;
  const input = Number.isFinite(stepUsage.input_tokens) && stepUsage.input_tokens >= 0
    ? Math.trunc(stepUsage.input_tokens)
    : 0;
  const cacheRead = Number.isFinite(stepUsage.cache_read_tokens) && stepUsage.cache_read_tokens >= 0
    ? Math.trunc(stepUsage.cache_read_tokens)
    : 0;
  const output = Number.isFinite(stepUsage.output_tokens) && stepUsage.output_tokens >= 0
    ? Math.trunc(stepUsage.output_tokens)
    : 0;
  const promptTokens = input + cacheRead;
  if (promptTokens <= 0) return undefined;
  const reportedTotal = Number.isFinite(stepUsage.total_tokens) && stepUsage.total_tokens >= 0
    ? Math.trunc(stepUsage.total_tokens)
    : 0;
  const totalTokens = Math.max(promptTokens + output, reportedTotal);
  return { state: "available", promptTokens, totalTokens };
}

function summedStepUsage(steps) {
  const usage = {};
  let lastStep;
  for (const stepUsage of steps) {
    lastStep = stepUsage;
    for (const [source] of USAGE_FIELDS) {
      if (Number.isFinite(stepUsage[source]) && stepUsage[source] >= 0) {
        usage[source] = (usage[source] ?? 0) + stepUsage[source];
      }
    }
  }
  const contextUsage = lastStepContextUsage(lastStep);
  if (contextUsage) usage.contextUsage = contextUsage;
  return Object.keys(usage).length ? usage : undefined;
}

function terminalResult(value) {
  if (!record(value) || typeof value.status !== "string" || !value.status.trim()) {
    throw new Error("AGY terminal result is missing its status.");
  }
  const result = {
    kind: "result",
    ...(typeof value.conversation_id === "string" && value.conversation_id
      ? { sessionId: value.conversation_id } : {}),
    ...(typeof value.response === "string" ? { text: value.response } : {}),
  };
  const usage = usageFrom(value.usage);
  if (usage) result.usage = usage;
  if (value.status !== "SUCCESS") {
    const detail = typeof value.error === "string" ? value.error
      : record(value.error) && typeof value.error.message === "string" ? value.error.message : "";
    result.errorText = `AGY turn ended with status ${value.status}${detail ? `: ${detail}` : "."}`;
  } else if (!result.text?.trim() && Array.isArray(value.denied_actions) && value.denied_actions.length) {
    const actions = value.denied_actions.filter(record)
      .map((action) => action.action).filter((action) => typeof action === "string");
    result.errorText = `AGY returned no reply after permission was denied${actions.length ? ` for ${actions.join(", ")}` : ""}.`;
  }
  return result;
}

function thinking(text) {
  return { kind: "thinking", text: text && text.length > 0 ? text : "…\n" };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Stateless projection; OpenClaw deduplicates tool snapshots by their native step identity. */
export function parseAntigravityJsonlEvent(line) {
  const value = decode(line);
  if (value.event === "init") {
    return typeof value.conversation_id === "string" && value.conversation_id
      ? { kind: "sessionId", sessionId: value.conversation_id } : [];
  }
  if (value.event === "result") return terminalResult(value.result);
  if (value.event === "openclaw_keepalive") {
    const elapsed = Number.isFinite(value.elapsed_seconds) ? Math.max(0, Math.round(value.elapsed_seconds)) : 0;
    return thinking(`… still working (${elapsed}s without output)\n`);
  }
  if (value.event !== "step_update") return [];
  const step = value.step_update;
  if (!record(step)) throw new Error("Invalid AGY step update.");
  if (step.step_type === "agent_response") {
    if (nonEmptyString(step.text_delta)) return [{ kind: "text", text: step.text_delta }];
    // Planning / tool-call steps carry no visible text; surface them as progress.
    return [thinking(nonEmptyString(step.thinking_delta) ?? nonEmptyString(step.thought) ?? "…\n")];
  }
  if (step.step_type !== "tool") {
    const explicit = nonEmptyString(step.thinking_delta) ?? nonEmptyString(step.thought);
    const label = typeof step.step_type === "string" || Number.isFinite(step.step_type)
      ? String(step.step_type) : "step";
    return [thinking(explicit ?? `… ${label}\n`)];
  }
  if (!Number.isSafeInteger(step.step_index) || step.step_index < 0 ||
      typeof step.conversation_id !== "string" || !step.conversation_id) {
    throw new Error("AGY tool step is missing its native identity.");
  }
  const info = record(step.tool_info) ? step.tool_info : {};
  const name = typeof step.tool_name === "string" && step.tool_name ? step.tool_name : info.name;
  if (typeof name !== "string" || !name) throw new Error("AGY tool step is missing its name.");
  const toolCallId = `agy:${step.conversation_id}:${step.step_index}`;
  const events = [{ kind: "toolStart", toolCallId, name,
    args: record(info.parameters) ? info.parameters : {} }];
  const terminal = ["DONE", "ERROR", "FAILED", "INTERRUPTED"].includes(step.state);
  if (terminal) {
    events.push({ kind: "toolResult", toolCallId, name,
      isError: step.state !== "DONE", result: info.output ?? info.error });
  }
  const mark = terminal ? (step.state === "DONE" ? " ✓" : " ✗") : "";
  events.push(thinking(`▸ ${name}${mark}\n`));
  return events;
}

// ---------------------------------------------------------------------------
// Shared helpers (one-shot path + live sessions)
// ---------------------------------------------------------------------------

const PROMPT_FLAGS = new Set(["--print", "-p", "--prompt"]);
const FORMAT_FLAGS = new Set(["--input-format", "--output-format"]);

/**
 * Rewrites the host-provided argv for agy's stream-json stdin mode:
 * drops `--print <prompt>`, rewrites `--resume <id>` to `--conversation <id>`
 * and pins the input/output formats.
 *
 * @param {readonly string[]} args
 */
export function normalizeAgyArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const hasConversation = list.some(
    (arg) => arg === "--conversation" || (typeof arg === "string" && arg.startsWith("--conversation=")),
  );
  const out = [];
  let rewrittenConversation = false;
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (typeof arg !== "string") {
      out.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const flag = arg.startsWith("--") && eq > 0 ? arg.slice(0, eq) : arg;
    if (PROMPT_FLAGS.has(arg)) {
      const next = list[index + 1];
      if (typeof next === "string" && (next === "{prompt}" || !next.startsWith("-"))) index += 1;
      continue;
    }
    if (flag === "--print" || flag === "--prompt") continue;
    if (FORMAT_FLAGS.has(arg)) {
      const next = list[index + 1];
      if (typeof next === "string" && !next.startsWith("-")) index += 1;
      continue;
    }
    if (FORMAT_FLAGS.has(flag)) continue;
    if (arg === "--resume") {
      const next = list[index + 1];
      if (typeof next === "string") index += 1;
      if (!hasConversation && !rewrittenConversation && typeof next === "string") {
        out.push("--conversation", next);
        rewrittenConversation = true;
      }
      continue;
    }
    if (arg.startsWith("--resume=")) {
      const id = arg.slice("--resume=".length);
      if (!hasConversation && !rewrittenConversation && id) {
        out.push("--conversation", id);
        rewrittenConversation = true;
      }
      continue;
    }
    out.push(arg);
  }
  return ["--input-format", "stream-json", "--output-format", "stream-json", ...out];
}

/** Joins system prompt / host context / prompt into the single user message agy receives. */
export function composeAgyPrompt(context, { includeSystemPrompt = true } = {}) {
  return [
    includeSystemPrompt && context.executionMode !== "side-question" && context.systemPrompt,
    context.promptContext?.prependContext,
    context.prompt,
    context.promptContext?.appendContext,
  ].filter((value) => typeof value === "string" && value.length > 0).join("\n\n");
}

/** One NDJSON user message for agy's `--input-format stream-json` stdin. */
export function agyUserMessage(text) {
  return `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
}

/**
 * Per-turn bookkeeping: step usage (per turn) and the false-positive error clearing.
 *
 * @param {{ useResume?: boolean }} context
 * @param {{ reusedProcess?: boolean }} [options] `reusedProcess`: agy reports cumulative usage.
 */
export function createTurnAccumulator(context, { reusedProcess = false } = {}) {
  let lastStepWasCompletedResponse = false;
  const responseUsage = new Map();
  return {
    /** Feed every decoded stdout object of the turn. */
    observe(value) {
      const step = value?.step_update;
      if (value?.event !== "step_update" || !record(step)) return;
      if (step.step_type === "agent_response" && step.state === "DONE") {
        lastStepWasCompletedResponse = true;
      } else if (
        step.step_type === "tool" ||
        step.state === "ERROR" ||
        step.state === "FAILED" ||
        step.state === "INTERRUPTED"
      ) {
        lastStepWasCompletedResponse = false;
      }
      if (
        (step.step_type === "agent_response" || step.step_type === "tool") &&
        step.state === "DONE" &&
        Number.isSafeInteger(step.step_index) &&
        record(step.usage)
      ) {
        responseUsage.set(step.step_index, step.usage);
      }
    },
    /** Rewrites the raw `result` event into the terminal record the host expects. */
    finalizeResult(value, { exitCode } = {}) {
      const outcome = terminalResult(value.result);
      let result = value.result;
      // AGY reports cumulative conversation usage on resume / warm processes; the
      // host accounts per run. Step usage is this turn. A resumed or reused turn
      // with none omits the cumulative total.
      const summed = summedStepUsage(responseUsage.values());
      if (summed) result = { ...result, usage: summed };
      else if ((context.useResume || reusedProcess) && record(result)) {
        const { usage: _usage, ...rest } = result;
        result = rest;
      }
      let isError = Boolean(outcome.errorText);
      // AGY's BuildJSONOutput scans the full conversation snapshot for any historical
      // or recovered retry error step (step_type=17) even when the current turn succeeded.
      // Clear that false positive when this turn finished with a completed agent_response
      // step and non-empty response text.
      if (
        (exitCode === 0 || exitCode === undefined) &&
        isError &&
        lastStepWasCompletedResponse &&
        record(result) &&
        typeof result.response === "string" &&
        result.response.trim().length > 0
      ) {
        const { error: _error, ...restResult } = result;
        result = { ...restResult, status: "SUCCESS" };
        isError = false;
      }
      return { ...value, result, type: "result", is_error: isError };
    },
  };
}

/** Terminates a detached process group (or the Windows process tree). */
export function killProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    // Windows has no POSIX process groups; use the OS process-tree terminator.
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore", windowsHide: true,
    });
    killer.once("error", () => child.kill(signal));
    killer.once("exit", (code) => { if (code !== 0) child.kill(signal); });
  } else {
    try { process.kill(-child.pid, signal); }
    catch (error) {
      if (error.code !== "ESRCH") throw error;
      // The group may be gone while the leader is not (non-detached spawns).
      try { child.kill(signal); } catch { /* already gone */ }
    }
  }
}

/**
 * Emits `onTick(elapsedSeconds)` while agy has been silent for at least one
 * interval (and less than `maxSilentMs`) so the host watchdog sees progress.
 */
export function createKeepalive({ intervalMs = 90_000, maxSilentMs = 720_000, onTick } = {}) {
  let lastTouch = Date.now();
  const timer = setInterval(() => {
    const silent = Date.now() - lastTouch;
    // Timers can fire marginally early; tolerate a little slack.
    if (silent >= intervalMs * 0.9 && silent < maxSilentMs) {
      onTick?.(Math.round(silent / 1000));
    }
  }, intervalMs);
  timer.unref?.();
  return {
    touch() { lastTouch = Date.now(); },
    stop() { clearInterval(timer); },
  };
}

/** Minimal unbounded async queue: `push`/`end` on one side, `for await` on the other. */
export function createAsyncQueue() {
  const items = [];
  const waiters = [];
  let ended = false;
  const done = { value: undefined, done: true };
  return {
    push(item) {
      if (ended) return false;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else items.push(item);
      return true;
    },
    end() {
      if (ended) return;
      ended = true;
      for (const waiter of waiters.splice(0)) waiter(done);
    },
    get ended() { return ended; },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (items.length > 0) return Promise.resolve({ value: items.shift(), done: false });
          if (ended) return Promise.resolve(done);
          return new Promise((resolve) => waiters.push(resolve));
        },
        return() {
          items.length = 0;
          return Promise.resolve(done);
        },
      };
    },
  };
}

/**
 * Turn status adapter (mirrors the Claude CLI contract): local facts only.
 *
 * @param {object} context host execute context
 * @param {{ isClosed: () => boolean, isCurrent: () => boolean }} state
 */
export function createTurnStatus(context, { isClosed, isCurrent }) {
  return {
    capture() {
      const current = () => {
        context.assertCurrent?.();
        return !context.abortSignal?.aborted && isCurrent();
      };
      if (!current()) return;
      return {
        isCurrent: current,
        async assess({ signal } = {}) {
          signal?.throwIfAborted();
          if (!current()) return { state: "unknown", basis: "status_unsupported" };
          if (isClosed()) return { state: "closed", basis: "transport_closed" };
          return { state: "unknown", basis: "process_present" };
        },
      };
    },
  };
}

/** Synthetic terminal record used when a turn is interrupted. */
export function syntheticInterruptResult(conversationId) {
  return {
    event: "result",
    type: "result",
    is_error: false,
    result: {
      status: "SUCCESS",
      response: "",
      ...(typeof conversationId === "string" && conversationId
        ? { conversation_id: conversationId }
        : {}),
    },
  };
}

/** Run the native CLI without accepting an EOF or a zero exit as a completed turn. */
export async function* executeAntigravityStream(context) {
  context.abortSignal?.throwIfAborted();
  context.assertCurrent?.();
  const args = normalizeAgyArgs(context.args);
  const prompt = composeAgyPrompt(context, { includeSystemPrompt: true });
  const child = spawn(context.command, args, {
    cwd: context.cwd, env: context.env, argv0: context.argv0,
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    detached: process.platform !== "win32",
  });
  context.onSpawn?.(child);
  const queue = createAsyncQueue();
  const accumulator = createTurnAccumulator(context);
  const keepalive = createKeepalive({
    intervalMs: context.keepaliveIntervalMs ?? 90_000,
    maxSilentMs: (context.maxSilentThinkingSeconds ?? 720) * 1000,
    onTick: (elapsed) => queue.push({ event: "openclaw_keepalive", elapsed_seconds: elapsed }),
  });
  let closed = false;
  let finished = false;
  let interrupted = false;
  let killTimer;
  let stderr = "";
  let streamError;
  let terminal = false;
  let terminalValue;
  let pending = "";
  const killTree = (signal) => killProcessTree(child, signal);
  const completion = new Promise((resolve) => {
    let error;
    let settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      // A tool can ignore SIGTERM and outlive its parent without holding pipes.
      // Finish cancellation for the whole group before resolving cleanup.
      if (killTimer && process.platform !== "win32") {
        try { killTree("SIGKILL"); } catch { /* already gone */ }
      }
      closed = true;
      clearTimeout(killTimer);
      keepalive.stop();
      if (!streamError && !interrupted && pending.trim()) handleLine(pending.trim());
      pending = "";
      if (!streamError && !interrupted && terminalValue) {
        try {
          queue.push(accumulator.finalizeResult(terminalValue, { exitCode: code }));
        } catch (finalizeError) {
          streamError = finalizeError;
        }
      }
      queue.end();
      resolve({ code, signal, error });
    };
    child.once("error", (value) => {
      error = value;
      // A failed spawn may never emit `close`.
      if (!child.pid) setImmediate(() => settle(null, null));
    });
    child.once("close", settle);
  });
  const terminate = () => {
    if (closed || killTimer) return;
    try { killTree("SIGTERM"); } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      if (!closed) { try { killTree("SIGKILL"); } catch { /* already gone */ } }
    }, 1_000);
    killTimer.unref();
  };
  const fail = (error) => {
    if (!streamError) streamError = error;
    terminate();
  };
  function handleLine(line) {
    if (interrupted || streamError) return;
    try {
      if (line.length > MAX_LINE_CHARS) throw new Error("AGY stream record exceeds the line limit.");
      if (terminal) throw new Error("AGY emitted another record after its terminal result.");
      const value = decode(line);
      keepalive.touch();
      accumulator.observe(value);
      if (value.event === "result") {
        terminalResult(value.result); // validates the status
        terminal = true;
        terminalValue = value;
        return;
      }
      queue.push(value);
    } catch (error) {
      fail(error);
    }
  }
  context.abortSignal?.addEventListener("abort", terminate, { once: true });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS); });
  child.stdin.on("error", () => {}); // A startup failure can close stdin before the prompt is written.
  child.stdin.end(agyUserMessage(prompt));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (interrupted || streamError) return;
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line) handleLine(line);
    }
    if (pending.length > MAX_LINE_CHARS) fail(new Error("AGY stream record exceeds the line limit."));
  });
  context.registerTurnStatus?.(createTurnStatus(context, {
    isClosed: () => closed,
    isCurrent: () => !finished && !interrupted,
  }));
  context.registerTurnInterrupt?.({
    async interrupt() {
      context.assertCurrent?.();
      if (terminal || finished || closed) return;
      interrupted = true;
      terminal = true;
      queue.push(syntheticInterruptResult());
      terminate();
      await completion;
    },
  });
  try {
    for await (const item of queue) {
      context.abortSignal?.throwIfAborted();
      context.assertCurrent?.();
      yield item;
    }
    const result = await completion;
    context.abortSignal?.throwIfAborted();
    context.assertCurrent?.();
    if (streamError) throw streamError;
    if (result.error) throw result.error;
    if (!interrupted) {
      if (result.code !== 0) {
        throw new Error(`AGY exited with code ${result.code ?? result.signal}${stderr.trim() ? `: ${stderr.trim()}` : "."}`);
      }
      if (!terminal) {
        const detail = stderr.trim();
        throw new Error(`AGY stream ended without a terminal result${detail ? `: ${detail}` : "."}`);
      }
    }
  } finally {
    finished = true;
    context.abortSignal?.removeEventListener("abort", terminate);
    keepalive.stop();
    terminate();
    await completion;
  }
}
