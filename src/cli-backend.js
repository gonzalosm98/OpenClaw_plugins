// CLI backend that drives Google's Antigravity CLI (`agy`) in print mode.
//
// This is the `claude -p` pattern: OpenClaw owns the conversation, agy owns
// inference and auth. agy authenticates itself against the user's Antigravity
// subscription, so this backend carries no API key and no auth methods.
//
// AGY's event/step_update/result dialect is translated by the public JSONL hook.
// The native CLI retains inference, tools, authentication, and compaction ownership.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import {
  ANTIGRAVITY_MODEL_ALIASES,
  isAntigravityEffortLevel,
  resolveAntigravityEffort,
  resolveAntigravityTransportModelId,
} from "./models.js";
import {
  MAX_PROMPT_ARG_CHARS,
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
  const args = ["--print", "{prompt}", "--output-format", "stream-json"];
  const mode = options.mode ?? DEFAULT_MODE;
  if (mode !== "none") {
    args.push("--mode", mode);
  }
  if (options.skipPermissions === true) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}

async function syncAntigravityMcpConfig(env, toolAvailability) {
  const settingsPath = env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (typeof settingsPath !== "string" || !settingsPath.trim()) {
    return null;
  }
  let parsedSettings;
  try {
    parsedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch {
    return null;
  }
  const sourceServers = parsedSettings?.mcpServers;
  if (!sourceServers || typeof sourceServers !== "object" || Array.isArray(sourceServers)) {
    return null;
  }
  const agyServers = {};
  for (const [name, server] of Object.entries(sourceServers)) {
    if (!server || typeof server !== "object" || Array.isArray(server)) {
      continue;
    }
    const serverUrl = server.serverUrl ?? server.url;
    const entry = {};
    if (typeof serverUrl === "string" && serverUrl.trim()) {
      entry.serverUrl = serverUrl.trim();
      if (server.headers && typeof server.headers === "object" && !Array.isArray(server.headers)) {
        entry.headers = server.headers;
      }
    } else if (typeof server.command === "string" && server.command.trim()) {
      entry.command = server.command.trim();
      if (Array.isArray(server.args)) entry.args = server.args;
      if (server.env && typeof server.env === "object") entry.env = server.env;
      if (typeof server.cwd === "string" && server.cwd.trim()) entry.cwd = server.cwd.trim();
    } else {
      continue;
    }
    if (name === "openclaw" && Array.isArray(toolAvailability?.openClaw)) {
      entry.enabledTools = toolAvailability.openClaw;
    } else if (Array.isArray(server.includeTools) && server.includeTools.length > 0) {
      entry.enabledTools = server.includeTools;
    }
    if (Array.isArray(server.excludeTools) && server.excludeTools.length > 0) {
      entry.disabledTools = server.excludeTools;
    }
    agyServers[name] = entry;
  }
  if (Object.keys(agyServers).length === 0) {
    return null;
  }
  const home = env?.HOME || env?.USERPROFILE || homedir();
  const mcpConfigPath = join(home, ".gemini", "config", "mcp_config.json");
  let previousRaw = null;
  let existingConfig = {};
  try {
    previousRaw = await readFile(mcpConfigPath, "utf8");
    if (previousRaw.trim()) {
      const parsed = JSON.parse(previousRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existingConfig = parsed;
      }
    }
  } catch {
    previousRaw = null;
  }
  const existingServers =
    existingConfig.mcpServers &&
    typeof existingConfig.mcpServers === "object" &&
    !Array.isArray(existingConfig.mcpServers)
      ? existingConfig.mcpServers
      : {};
  const mergedConfig = {
    ...existingConfig,
    mcpServers: {
      ...existingServers,
      ...agyServers,
    },
  };
  await mkdir(dirname(mcpConfigPath), { recursive: true });
  await writeFile(mcpConfigPath, `${JSON.stringify(mergedConfig, null, 2)}\n`, "utf8");
  return async () => {
    try {
      const restored =
        previousRaw && previousRaw.trim()
          ? previousRaw
          : `${JSON.stringify({ mcpServers: existingServers }, null, 2)}\n`;
      await writeFile(mcpConfigPath, restored, "utf8");
    } catch {
      // Ignore cleanup errors
    }
  };
}

/**
 * @param {{command?: string, mode?: string, skipPermissions?: boolean}} [options]
 *   Plugin config from `plugins.entries.antigravity.config`.
 */
export function buildAntigravityCliBackend(options = {}, effortStore) {
  const base = buildBaseArgs(options);
  const command = resolveAntigravityCommand(options.command?.trim() || DEFAULT_COMMAND);
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
    bundleMcpMode: "gemini-system-settings",
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
        const cleanupMcp = await syncAntigravityMcpConfig(env, context?.toolAvailability);
        try {
          yield* executeAntigravityStream({
            ...context,
            env,
            command: resolveAntigravityCommand(context?.command, env),
          });
        } finally {
          await cleanupMcp?.();
        }
      },
    }),
    resolveExecutionArgs: ({ baseArgs, executionMode, thinkingLevel, modelId }) => {
      // agy requires `--effort` on models with effort rows, including the
      // setup probe. Legacy models without effort rows omit the flag.
      const args = resolveAntigravityEffortArgs(
        baseArgs,
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
      // agy resumes by conversation id; there is no separate session concept.
      resumeArgs: [...base, "--conversation", "{sessionId}"],
      output: "jsonl",
      resumeOutput: "jsonl",
      input: "arg",
      // agy takes the prompt as an argv value. Very long prompts blow the argv
      // limit, so hand those to stdin instead.
      maxPromptArgChars: MAX_PROMPT_ARG_CHARS,
      modelArg: "--model",
      modelAliases: { ...ANTIGRAVITY_MODEL_ALIASES },
      sessionMode: "existing",
      sessionIdFields: ["conversation_id"],
      // One agy process at a time: concurrent print-mode runs against the same
      // conversation interleave writes to its history.
      serialize: true,
    },
  };
}
