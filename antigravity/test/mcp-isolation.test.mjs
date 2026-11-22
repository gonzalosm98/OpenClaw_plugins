import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  prepareAgyMcpIsolation,
  stripHostMcpArgs,
  toAgyMcpConfig,
} from "../src/mcp-isolation.js";

test("stripHostMcpArgs removes host MCP flags and collects config paths and disallowedTools", () => {
  const result = stripHostMcpArgs([
    "--mode",
    "accept-edits",
    "--strict-mcp-config",
    "--mcp-config",
    "/tmp/a.json",
    "/tmp/b.json",
    "--mcp-config=/tmp/c.json",
    "--disallowedTools",
    "mcp__openclaw__exec,mcp__openclaw__write",
    "--disallowed-tools=mcp__foo__bar",
    "--disable-slash-commands",
  ]);
  assert.deepEqual(result.args, ["--mode", "accept-edits", "--disable-slash-commands"]);
  assert.deepEqual(result.mcpConfigPaths, ["/tmp/a.json", "/tmp/b.json", "/tmp/c.json"]);
  assert.deepEqual(result.disallowedTools, [
    "mcp__openclaw__exec",
    "mcp__openclaw__write",
    "mcp__foo__bar",
  ]);
});

test("toAgyMcpConfig transforms http/stdio servers, placeholders, timeoutSeconds, enabledTools, disabledTools, and omits openclaw when openClaw is []", () => {
  const source = {
    openclaw: {
      url: "http://127.0.0.1:9999/mcp",
      headers: { Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}" },
    },
    local_stdio: {
      command: "node",
      args: ["server.js"],
      env: { DEBUG: "1" },
      cwd: "/tmp/work",
      includeTools: ["read_item", "list_items"],
      excludeTools: ["drop_item"],
    },
    "my.server": {
      serverUrl: "http://127.0.0.1:8080/sse",
    },
  };

  const config = toAgyMcpConfig(source, {
    toolAvailability: { openClaw: ["memory_search", "session_status"] },
    disallowedTools: ["mcp__my_server__danger", "mcp__local_stdio__secret"],
    mcpTimeoutSeconds: 450,
    env: { OPENCLAW_MCP_TOKEN: "tok-abc" },
  });

  assert.deepEqual(config.mcpServers.openclaw, {
    serverUrl: "http://127.0.0.1:9999/mcp",
    headers: { Authorization: "Bearer tok-abc" },
    timeoutSeconds: 450,
    enabledTools: ["memory_search", "session_status"],
  });
  assert.deepEqual(config.mcpServers.local_stdio, {
    command: "node",
    args: ["server.js"],
    env: { DEBUG: "1" },
    cwd: "/tmp/work",
    timeoutSeconds: 450,
    enabledTools: ["read_item", "list_items"],
    disabledTools: ["drop_item", "secret"],
  });
  assert.deepEqual(config.mcpServers["my.server"], {
    serverUrl: "http://127.0.0.1:8080/sse",
    timeoutSeconds: 450,
    disabledTools: ["danger"],
  });

  // Empty openClaw availability omits the openclaw server entry instead of writing enabledTools: []
  const omitted = toAgyMcpConfig(
    { openclaw: source.openclaw },
    { toolAvailability: { openClaw: [] }, env: { OPENCLAW_MCP_TOKEN: "tok-abc" } },
  );
  assert.deepEqual(omitted, { mcpServers: {} });
});

test("prepareAgyMcpIsolation creates private .agents/mcp_config.json, appends --add-dir, and cleans up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-mcp-test-"));
  try {
    const mcpFile = join(dir, "host-mcp.json");
    await writeFile(
      mcpFile,
      JSON.stringify({
        mcpServers: {
          openclaw: {
            url: "http://127.0.0.1:4321/mcp",
            headers: { Authorization: "Bearer ${SECRET_TOK}" },
          },
        },
      }),
    );

    const iso = await prepareAgyMcpIsolation({
      args: ["--strict-mcp-config", "--mcp-config", mcpFile, "--mode", "accept-edits"],
      env: { SECRET_TOK: "s3cr3t" },
      toolAvailability: { openClaw: ["echo_tool"] },
      mcpTimeoutSeconds: 300,
    });

    assert.ok(iso.dir);
    assert.deepEqual(iso.args, ["--mode", "accept-edits", "--add-dir", iso.dir]);
    const written = JSON.parse(await readFile(join(iso.dir, ".agents", "mcp_config.json"), "utf8"));
    assert.deepEqual(written, {
      mcpServers: {
        openclaw: {
          serverUrl: "http://127.0.0.1:4321/mcp",
          headers: { Authorization: "Bearer s3cr3t" },
          timeoutSeconds: 300,
          enabledTools: ["echo_tool"],
        },
      },
    });

    await iso.cleanup();
    await iso.cleanup(); // idempotent
    assert.equal(existsSync(iso.dir), false);

    // Fallback to GEMINI_CLI_SYSTEM_SETTINGS_PATH
    const settingsFile = join(dir, "gemini-settings.json");
    await writeFile(
      settingsFile,
      JSON.stringify({
        mcpServers: {
          helper: { command: "echo", args: ["hi"] },
        },
      }),
    );
    const fallbackIso = await prepareAgyMcpIsolation({
      args: ["--mode", "accept-edits"],
      env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile },
    });
    assert.ok(fallbackIso.dir);
    const fallbackWritten = JSON.parse(
      await readFile(join(fallbackIso.dir, ".agents", "mcp_config.json"), "utf8"),
    );
    assert.equal(fallbackWritten.mcpServers.helper.command, "echo");
    await fallbackIso.cleanup();

    // No servers after filtering -> no dir created
    const emptyIso = await prepareAgyMcpIsolation({
      args: ["--strict-mcp-config", "--mcp-config", mcpFile],
      toolAvailability: { openClaw: [] },
    });
    assert.equal(emptyIso.dir, undefined);
    assert.deepEqual(emptyIso.args, []);
    await emptyIso.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
