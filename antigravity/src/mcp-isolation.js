// Per-process MCP isolation for agy.
//
// The host hands MCP servers to a CLI backend as Claude-style flags
// (`--strict-mcp-config --mcp-config <file> --disallowedTools ...`). agy does
// not understand those. Instead of mutating the GLOBAL agy MCP config (racy when
// runs are parallel), the servers are translated into a private
// `<dir>/.agents/mcp_config.json` that is attached to a single agy process with
// `--add-dir <dir>`.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyStrings(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && entry.length > 0)
    : [];
}

/**
 * Removes the Claude-style MCP flags the host appends and collects their values.
 *
 * @param {readonly string[]} args
 */
export function stripHostMcpArgs(args) {
  const out = [];
  const mcpConfigPaths = [];
  const disallowedTools = [];
  const list = Array.isArray(args) ? args : [];
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (typeof arg !== "string") {
      out.push(arg);
      continue;
    }
    if (arg === "--strict-mcp-config") continue;
    if (arg === "--mcp-config") {
      // The host's form is variadic: consume following values that are not flags.
      while (typeof list[index + 1] === "string" && !list[index + 1].startsWith("-")) {
        mcpConfigPaths.push(list[index + 1]);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      const value = arg.slice("--mcp-config=".length);
      if (value) mcpConfigPaths.push(value);
      continue;
    }
    if (arg === "--disallowedTools" || arg === "--disallowed-tools") {
      const value = list[index + 1];
      if (typeof value === "string" && !value.startsWith("-")) {
        disallowedTools.push(...value.split(",").map((tool) => tool.trim()).filter(Boolean));
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("--disallowedTools=") || arg.startsWith("--disallowed-tools=")) {
      const value = arg.slice(arg.indexOf("=") + 1);
      disallowedTools.push(...value.split(",").map((tool) => tool.trim()).filter(Boolean));
      continue;
    }
    out.push(arg);
  }
  return { args: out, mcpConfigPaths, disallowedTools };
}

function resolvePlaceholders(value, env) {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (match, name) => {
    const resolved = env?.[name];
    return typeof resolved === "string" ? resolved : match;
  });
}

function normalizeServerName(name) {
  return name.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

/**
 * Converts host/Gemini-style MCP server entries into agy's `mcp_config.json`.
 * Pure: no I/O.
 *
 * @param {Record<string, any>} sourceServers
 * @param {{
 *   toolAvailability?: { openClaw?: string[] },
 *   disallowedTools?: string[],
 *   mcpTimeoutSeconds?: number,
 *   env?: NodeJS.ProcessEnv,
 * }} [options]
 */
export function toAgyMcpConfig(sourceServers, options = {}) {
  const { toolAvailability, disallowedTools = [], mcpTimeoutSeconds = 600, env = {} } = options;
  const mcpServers = {};
  if (!record(sourceServers)) return { mcpServers };
  for (const [name, server] of Object.entries(sourceServers)) {
    if (!record(server)) continue;
    const serverUrl = [server.serverUrl, server.url].find(
      (value) => typeof value === "string" && value.trim(),
    );
    const entry = {};
    if (serverUrl) {
      entry.serverUrl = serverUrl.trim();
      if (record(server.headers)) {
        const headers = {};
        for (const [key, value] of Object.entries(server.headers)) {
          if (typeof value === "string") headers[key] = resolvePlaceholders(value, env);
        }
        if (Object.keys(headers).length > 0) entry.headers = headers;
      }
    } else if (typeof server.command === "string" && server.command.trim()) {
      entry.command = server.command.trim();
      if (Array.isArray(server.args)) entry.args = server.args;
      if (record(server.env)) entry.env = server.env;
      if (typeof server.cwd === "string" && server.cwd.trim()) entry.cwd = server.cwd.trim();
    } else {
      continue;
    }
    entry.timeoutSeconds = mcpTimeoutSeconds;
    const includeTools = nonEmptyStrings(server.includeTools);
    if (name === "openclaw" && Array.isArray(toolAvailability?.openClaw)) {
      if (toolAvailability.openClaw.length === 0) continue;
      entry.enabledTools = [...toolAvailability.openClaw];
    } else if (includeTools.length > 0) {
      entry.enabledTools = includeTools;
    }
    const normalized = normalizeServerName(name);
    const prefix = `mcp__${normalized}__`;
    const disabled = new Set(nonEmptyStrings(server.excludeTools));
    for (const tool of disallowedTools) {
      if (!tool.startsWith("mcp__")) continue;
      const rest = tool.slice("mcp__".length);
      const split = rest.indexOf("__");
      if (split <= 0) continue;
      if (rest.slice(0, split) === normalized && tool.startsWith(prefix) && tool.length > prefix.length) {
        disabled.add(tool.slice(prefix.length));
      }
    }
    if (disabled.size > 0) entry.disabledTools = [...disabled];
    mcpServers[name] = entry;
  }
  return { mcpServers };
}

async function readServers(path) {
  try {
    const parsed = JSON.parse(await readFile(isAbsolute(path) ? path : resolve(path), "utf8"));
    return record(parsed?.mcpServers) ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

/**
 * Strips the host MCP flags from `args` and, when servers exist, writes a private
 * agy config dir and appends `--add-dir <dir>`.
 *
 * @param {{
 *   args: readonly string[],
 *   env?: NodeJS.ProcessEnv,
 *   toolAvailability?: { openClaw?: string[] },
 *   mcpTimeoutSeconds?: number,
 * }} options
 * @returns {Promise<{ args: string[], dir: string | undefined, cleanup: () => Promise<void> }>}
 */
export async function prepareAgyMcpIsolation({
  args,
  env = process.env,
  toolAvailability,
  mcpTimeoutSeconds = 600,
}) {
  const stripped = stripHostMcpArgs(args);
  let sourceServers = {};
  for (const path of stripped.mcpConfigPaths) {
    Object.assign(sourceServers, await readServers(path));
  }
  if (Object.keys(sourceServers).length === 0) {
    const legacy = env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
    if (typeof legacy === "string" && legacy.trim()) {
      sourceServers = await readServers(legacy);
    }
  }
  const config = toAgyMcpConfig(sourceServers, {
    toolAvailability,
    disallowedTools: stripped.disallowedTools,
    mcpTimeoutSeconds,
    env,
  });
  if (Object.keys(config.mcpServers).length === 0) {
    return { args: stripped.args, dir: undefined, cleanup: async () => {} };
  }
  const dir = await mkdtemp(join(tmpdir(), "openclaw-agy-mcp-"));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  };
  try {
    await mkdir(join(dir, ".agents"), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, ".agents", "mcp_config.json"), `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
    });
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { args: [...stripped.args, "--add-dir", dir], dir, cleanup };
}
