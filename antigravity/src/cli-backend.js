// CLI backend that drives Google's Antigravity CLI (`agy`) in stream-json mode.
//
// This is the `claude -p` / `claude-stdio` pattern: OpenClaw owns the conversation,
// agy owns inference and auth. agy authenticates itself against the user's Antigravity
// subscription, so this backend carries no API key and no auth methods.
//
// AGY's event/step_update/result dialect is translated by the public JSONL hook.
// The native CLI retains inference, tools, authentication, and compaction ownership.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { createKeyedMutex, createSemaphore } from "./concurrency.js";
import { executeAntigravityLiveTurn } from "./live-session.js";
import { prepareAgyMcpIsolation } from "./mcp-isolation.js";
import {
  ANTIGRAVITY_MODEL_ALIASES,
  isAntigravityEffortLevel,
  resolveAntigravityEffort,
  resolveAntigravityTransportModelId,
} from "./models.js";
import {
  executeAntigravityStream,
  parseAntigravityJsonlEvent,
} from "./stream.js";

export const ANTIGRAVITY_BACKEND_ID = "antigravity-cli";
export const TOOL_FREE_SETUP_AGENT_ID = "openclaw-antigravity-setup";
const DEFAULT_COMMAND = "agy";

/**
 * Resolves `agy` for Gateway services whose PATH is only the service bins.
 * Google's installer puts the binary in `~/.local/bin`, which launchd/systemd
 * PATH typically omits even when a login shell can run `agy`.
 *
 * @param {string} [command]
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(path: string) => boolean} [fileExists]
 */
export function resolveAntigravityCommand(
  command = DEFAULT_COMMAND,
  env = process.env,
  fileExists = existsSync,
) {
  const requested = String(command ?? "").trim() || DEFAULT_COMMAND;
  if (isAbsolute(requested) || requested.includes("/") || requested.includes("\\")) {
    return requested;
  }
  const names =
    process.platform === "win32" && !requested.toLowerCase().endsWith(".exe")
      ? [requested, `${requested}.exe`]
      : [requested];
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = [];
  const seen = new Set();
  const addDir = (dir) => {
    if (!dir || seen.has(dir)) {
      return;
    }
    seen.add(dir);
    dirs.push(dir);
  };
  for (const dir of String(env.PATH || "").split(delimiter)) {
    addDir(dir);
  }
  addDir(join(home, ".local", "bin"));
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return requested;
}

/**
 * Inherit the host env and put the agy installer location on PATH so `execFile`
 * can find `agy` even when the Gateway service PATH does not include it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildAntigravityCommandEnv(env = process.env) {
  const merged = { ...process.env, ...env };
  const home = merged.HOME || merged.USERPROFILE || homedir();
  const extra = join(home, ".local", "bin");
  const parts = [];
  const seen = new Set();
  for (const dir of [extra, ...String(merged.PATH || "").split(delimiter)]) {
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    parts.push(dir);
  }
  merged.PATH = parts.join(delimiter);
  return merged;
}

/** agy print mode cannot prompt a human, so tool calls need a non-review mode. */
export const DEFAULT_MODE = "accept-edits";

const EFFORT_ARG = "--effort";

function stripEffortArgs(args) {
  const normalized = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === EFFORT_ARG) {
      const maybeValue = args[index + 1];
      if (
        typeof maybeValue === "string" &&
        maybeValue.trim().length > 0 &&
        !maybeValue.startsWith("-")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith(`${EFFORT_ARG}=`)) {
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

/**
 * Replaces any `--effort` in args with a resolved effort level.
 * Unset, `off`, and values that are not effort levels omit the flag.
 *
 * @param {readonly string[]} baseArgs
 * @param {string | null | undefined} thinkingLevel
 */
export function resolveAntigravityEffortArgs(baseArgs, thinkingLevel) {
  const level = typeof thinkingLevel === "string" ? thinkingLevel.trim().toLowerCase() : "";
  const args = stripEffortArgs(baseArgs);
  if (!isAntigravityEffortLevel(level)) {
    return args;
  }
  return [...args, EFFORT_ARG, level];
}

/**
 * Builds the args every invocation shares.
 *
 * @param {{mode?: string, skipPermissions?: boolean}} [options]
 */
export function buildBaseArgs(options = {}) {
  const args = ["--input-format", "stream-json", "--output-format", "stream-json"];
  const mode = options.mode ?? DEFAULT_MODE;
  if (mode !== "none") {
    args.push("--mode", mode);
  }
  if (options.skipPermissions === true) {
    args.push("--dangerously-skip-permissions");
  }
  args.push("--disable-slash-commands");
  return args;
}

/**
 * @param {{
 *   command?: string,
 *   mode?: string,
 *   skipPermissions?: boolean,
 *   maxConcurrency?: number,
 *   liveSession?: boolean,
 *   idleTimeoutSeconds?: number,
 *   maxSilentThinkingSeconds?: number,
 *   mcpTimeoutSeconds?: number,
 * }} [options]
 *   Plugin config from `plugins.entries.antigravity.config`.
 */
export function buildAntigravityCliBackend(options = {}, effortStore) {
  const base = buildBaseArgs(options);
  const defaultCommand = options.command?.trim() || DEFAULT_COMMAND;
  const command = resolveAntigravityCommand(defaultCommand);
  const semaphore = createSemaphore(options.maxConcurrency ?? 4);
  const sessionMutex = createKeyedMutex();
  const idleTimeoutMs = (options.idleTimeoutSeconds ?? 600) * 1000;
  const maxSilentThinkingSeconds = options.maxSilentThinkingSeconds ?? 720;
  const maxSilentMs = maxSilentThinkingSeconds * 1000;
  const mcpTimeoutSeconds = options.mcpTimeoutSeconds ?? 600;
  return {
    id: ANTIGRAVITY_BACKEND_ID,
    // Models are antigravity-cli/<model>, so this backend's id is the canonical provider.
    modelProvider: ANTIGRAVITY_BACKEND_ID,
    // Stock CLI runtime-artifact policy. A native agy binary is admitted through
    // nativeExecutableNames. packageName is read only when the command is a
    // script whose package.json owns the tree.
    runtimeArtifact: {
      kind: "bundled-package-tree",
      packageName: "agy",
      entrypoint: "command",
      nativeExecutableNames: ["agy", "agy.exe"],
    },
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    subscriptionAuthDispatch: true,
    sideQuestionToolMode: "disabled",
    nativeToolMode: "selectable",
    toolAvailabilityEnforcement: "prepare-execution",
    ownsNativeCompaction: true,
    parseJsonlEvent: parseAntigravityJsonlEvent,
    prepareExecution: (prepCtx) => ({
      toolAvailabilityEnforced: true,
      ...(prepCtx?.isolatedCompletionPrompt !== undefined ? { isolatedCompletionEnforced: true } : {}),
      execute: async function* (context) {
        const env = buildAntigravityCommandEnv(context?.env);
        const resolvedCommand = resolveAntigravityCommand(context?.command ?? defaultCommand, env);
        if (context?.liveSession && context?.executionMode !== "side-question") {
          yield* executeAntigravityLiveTurn(
            { ...context, env, command: resolvedCommand },
            { semaphore, idleTimeoutMs, maxSilentMs, mcpTimeoutSeconds },
          );
          return;
        }
        const releaseMutex = await sessionMutex.lock(context?.sessionId);
        let releaseSemaphore;
        let iso;
        try {
          releaseSemaphore = await semaphore.acquire(context?.abortSignal);
          iso = await prepareAgyMcpIsolation({
            args: context?.args ?? [],
            env,
            toolAvailability: context?.toolAvailability,
            mcpTimeoutSeconds,
          });
          yield* executeAntigravityStream({
            ...context,
            args: iso.args,
            env,
            command: resolvedCommand,
            maxSilentThinkingSeconds,
          });
        } finally {
          await iso?.cleanup();
          releaseSemaphore?.();
          releaseMutex();
        }
      },
    }),
    resolveExecutionArgs: ({ baseArgs, executionMode, thinkingLevel, modelId }) => {
      // agy requires `--effort` on models with effort rows, including the
      // setup probe. Legacy models without effort rows omit the flag.
      const args = resolveAntigravityEffortArgs(
        baseArgs ?? [],
        resolveAntigravityEffort(modelId, thinkingLevel, effortStore),
      );
      return executionMode === "side-question"
        ? [...args, "--agent", TOOL_FREE_SETUP_AGENT_ID]
        : args;
    },
    resolveModelId: ({ modelId }) => resolveAntigravityTransportModelId(modelId),
    config: {
      command,
      args: [...base],
      // agy resumes by conversation id; OpenClaw's liveSession fingerprint
      // strips `--resume`, and normalizeAgyArgs rewrites it to `--conversation` at spawn.
      resumeArgs: [...base, "--resume", "{sessionId}"],
      output: "jsonl",
      resumeOutput: "jsonl",
      input: "stdin",
      liveSession: options.liveSession === false ? undefined : "claude-stdio",
      modelArg: "--model",
      modelAliases: { ...ANTIGRAVITY_MODEL_ALIASES },
      sessionMode: "existing",
      sessionIdFields: ["conversation_id"],
      serialize: false,
      imagePathScope: "workspace",
      reliability: {
        watchdog: {
          fresh: { noOutputTimeoutRatio: 0.9, minMs: 300_000, maxMs: 900_000 },
          resume: { noOutputTimeoutRatio: 0.9, minMs: 300_000, maxMs: 900_000 },
        },
      },
    },
  };
}
