// Shared harness for live smoke tests against a running Factorio + MCP server.
// These scripts are NOT unit tests (deliberately not named *.test.ts - bun test
// would try to run them without a live game). Run them directly with bun.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "node:path";
import { RCONClient } from "../../src/rcon/client";
import { getRCONConfig } from "../../src/config";

export const EPS = 0.01;

// The server resolves skill scripts, .fac-skills/ and .env relative to its cwd,
// so it must be spawned from the repo root regardless of where this is invoked.
const REPO_ROOT = resolve(import.meta.dir, "../..");

/** The MCP SDK does NOT pass the parent's environment to the server it spawns - it substitutes a
 *  sanitized default (PATH, HOME, ...). Without this merge the spawned server falls back to the
 *  repo's .env while the harness's own side-channel RCON honours whatever FACTORIO_* overrides the
 *  caller exported, so the two halves of a suite silently talk to DIFFERENT Factorio instances -
 *  which reads exactly like a code failure. (Caught 2026-07-26 running t034 against a headless
 *  test server on a second RCON port: the banner reported stale mod code that a direct RCON probe
 *  had just shown fresh.) Forwarding the real environment is also what makes
 *  `FACTORIO_RCON_PORT=... bun run scripts/smoke/<suite>.ts` work at all. */
function serverEnvironment(): Record<string, string> {
  const merged: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

export async function connectMCP(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", "src/index.ts"],
    cwd: REPO_ROOT,
    env: serverEnvironment(),
    stderr: "pipe",
  });
  const client = new Client({ name: "smoke-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

export async function connectRCON(): Promise<{ send: (cmd: string) => Promise<string>; close: () => Promise<void> }> {
  const rcon = new RCONClient(getRCONConfig());
  await rcon.connect();
  return {
    send: async (cmd: string) => {
      const response = await rcon.sendCommand(cmd);
      if (!response.success) {
        throw new Error(`RCON command failed: ${cmd}\n  ${response.error}`);
      }
      return response.data;
    },
    close: async () => {
      await rcon.disconnect();
    },
  };
}

/** Wraps a Lua snippet in /silent-command. The snippet must rcon.print() its own JSON. */
export async function silent(rcon: { send: (cmd: string) => Promise<string> }, lua: string): Promise<string> {
  return rcon.send(`/silent-command ${lua}`);
}

export async function callToolRaw(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }> | undefined;
  const first = content?.[0];
  if (!first || first.type !== "text" || first.text === undefined) {
    throw new Error(`Tool ${name} returned non-text content: ${JSON.stringify(result)}`);
  }
  return first.text;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const text = await callToolRaw(client, name, args);
  if (text.startsWith("Error: ")) {
    throw new Error(`Tool ${name} returned an error: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface CheckRecord {
  label: string;
  pass: boolean;
  detail?: string;
}
const checks: CheckRecord[] = [];

export function check(label: string, pass: boolean, detail?: string): void {
  checks.push({ label, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`[${tag}] ${label}`);
  if (detail !== undefined) {
    console.log(`    ${detail}`);
  }
}

export function summary(): number {
  const failed = checks.filter((c) => !c.pass);
  console.log("\n=== SUMMARY ===");
  console.log(`${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) {
    console.log("FAILED:");
    for (const f of failed) {
      console.log(` - ${f.label}${f.detail !== undefined ? `: ${f.detail}` : ""}`);
    }
  }
  return failed.length ? 1 : 0;
}
