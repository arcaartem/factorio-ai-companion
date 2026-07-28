#!/usr/bin/env bun
// Runs live smoke suites against a DISPOSABLE headless Factorio server, so verifying a mod change
// needs no manual "main menu -> Host Saved Game" and does not touch the game you are playing.
//
// WHY THIS EXISTS. Control-stage Lua is re-read from disk only when a save is LOADED. There is no
// in-game reload: `game.reload_script()` and `game.reload_mods()` are both reachable over RCON and
// both return success while changing nothing in a hosted multiplayer game (probed 2026-07-26 with
// a behavioural discriminator, not by trusting the reply). `script.active_mods` is no help either
// - it is pinned at APPLICATION startup, and was observed reading 0.13.7 while 0.16.0 code ran.
// So the only real reload is a fresh process, which is exactly what this script gives you: it
// starts a server, the server loads the save, the save load reads the mod off disk.
//
// It also isolates the blast radius. Smoke suites teleport companions, plant ore, spawn biters and
// spill items; before this they did all of that in the save you actually play. Here they run
// against a COPY, thrown away afterwards.
//
// Usage (from the repo root):
//   bun run scripts/smoke/test-server.ts scripts/smoke/t034-nearest-resource.ts
//   bun run scripts/smoke/test-server.ts t031 t034            # substring match against scripts/smoke/
//   bun run scripts/smoke/test-server.ts --serve              # just start it and stay up (Ctrl-C to stop)
//   bun run scripts/smoke/test-server.ts --save <path> t034   # against a specific save
//   bun run scripts/smoke/test-server.ts --client t051        # also attach a real client, for combat suites
//
// Env overrides: FACTORIO_BIN, FACTORIO_TEST_PORT (game, default 34200),
// FACTORIO_TEST_RCON_PORT (default 34199).
//
// LIMITATION worth knowing before you pick a suite: with no client connected,
// `game.players[1]` exists and is valid but has NO character, so anything sourcing items from the
// player fails - a companion spawns successfully but UNARMED ("no gun available"). Mining,
// movement, building and world-query suites are fine; the COMBAT suites (t021, t026) need either a
// connected client or harness-side arming. Everything here reports that state at startup rather
// than letting a suite fail obscurely on it.
//
// --client launches a real Factorio client (its own third write-data dir, so it does not collide
// with the server's or your own game's) and connects it to the disposable server, so combat suites
// can automate too. It reuses your real player-data.json so the client authenticates as the SAME
// account the save knows as game.players[1] - without that it would connect as a fresh player[2]
// and the arming logic (which reads game.players[1] specifically) would still find no character.
// The server it joins runs against a COPY of the save (see writeScratchFiles below), so nothing the
// client or a combat suite does persists back to the save you actually play.
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, writeFileSync, rmSync, openSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { RCONClient } from "../../src/rcon/client";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const SMOKE_DIR = join(REPO_ROOT, "scripts/smoke");
const SCRATCH = join(REPO_ROOT, ".fac-test-server");
const FACTORIO_USER_DIR = join(process.env.HOME!, "Library/Application Support/factorio");
const MODS_DIR = join(FACTORIO_USER_DIR, "mods");
const SAVES_DIR = join(FACTORIO_USER_DIR, "saves");

const GAME_PORT = process.env.FACTORIO_TEST_PORT || "34200";
const RCON_PORT = process.env.FACTORIO_TEST_RCON_PORT || "34199";
// Localhost-bound, LAN and public visibility both off - this is not a reachable server.
const RCON_PASSWORD = "factorio";

const READY_TIMEOUT_MS = 90000;
const READY_POLL_MS = 1000;
// The client has more to do before it can join (load assets, connect, download/verify the save)
// than the server needs to just start answering RCON, so it gets a longer budget.
const CLIENT_READY_TIMEOUT_MS = 120000;

/** Candidate install locations, in preference order. FACTORIO_BIN wins if set. */
function findFactorioBinary(): string {
  const fromEnv = process.env.FACTORIO_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`FACTORIO_BIN is set to ${fromEnv}, which does not exist.`);
    return fromEnv;
  }
  const candidates = [
    "/Applications/factorio.app/Contents/MacOS/factorio",
    join(process.env.HOME!, "Applications/factorio.app/Contents/MacOS/factorio"),
    join(process.env.HOME!, "Library/Application Support/Steam/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio"),
  ];
  // Steam libraries frequently live on an external volume, so sweep /Volumes/*/ too.
  try {
    for (const vol of readdirSync("/Volumes")) {
      candidates.push(`/Volumes/${vol}/MacosSteamLibrary/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio`);
      candidates.push(`/Volumes/${vol}/SteamLibrary/steamapps/common/Factorio/factorio.app/Contents/MacOS/factorio`);
    }
  } catch { /* /Volumes unreadable - the fixed candidates still apply */ }

  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    `Could not find the Factorio binary. Set FACTORIO_BIN to its path.\nTried:\n  ${candidates.join("\n  ")}`
  );
}

/** Newest save, excluding Steam bookkeeping. Autosaves are included deliberately - they are the
 *  most recent state of the world you are playing. */
function newestSave(): string {
  const entries = readdirSync(SAVES_DIR)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => ({ path: join(SAVES_DIR, f), mtime: statSync(join(SAVES_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!entries.length) throw new Error(`No .zip saves found in ${SAVES_DIR}`);
  return entries[0]!.path;
}

/** Copies factorio-mod/ into the live mods dir and asserts the copy is exact. The deployed dir is
 *  the only code Factorio executes and it has silently held a PARTIAL sync before (2026-07-24), so
 *  this is a gate, not a convenience. */
async function deployMod(): Promise<void> {
  const target = join(MODS_DIR, "ai-companion");
  const cp = Bun.spawn(["cp", "-r", join(REPO_ROOT, "factorio-mod") + "/.", target], { stdout: "pipe", stderr: "pipe" });
  if ((await cp.exited) !== 0) throw new Error(`Deploy failed: ${await new Response(cp.stderr).text()}`);

  const diff = Bun.spawn(["diff", "-rq", join(REPO_ROOT, "factorio-mod"), target], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(diff.stdout).text();
  if ((await diff.exited) !== 0 || out.trim()) {
    throw new Error(`Deployed mod does not match factorio-mod/ after copying:\n${out}`);
  }
  const version = JSON.parse(await Bun.file(join(REPO_ROOT, "factorio-mod/info.json")).text()).version;
  console.log(`[test-server] deployed ai-companion ${version} -> ${target} (diff -rq clean)`);
}

function writeScratchFiles(binary: string, savePath: string): { config: string; settings: string; save: string } {
  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(join(SCRATCH, "write-data"), { recursive: true });

  // A second Factorio process cannot share the user data directory - the first holds an exclusive
  // lock on it - so the test server gets its own write-data root.
  const readData = resolve(binary, "../../data");
  const config = join(SCRATCH, "config.ini");
  writeFileSync(config, `[path]\nread-data=${readData}\nwrite-data=${join(SCRATCH, "write-data")}\n`);

  const settings = join(SCRATCH, "server-settings.json");
  writeFileSync(settings, JSON.stringify({
    name: "factorio-smoke-test-local",
    description: "Ephemeral local test server (scripts/smoke/test-server.ts)",
    visibility: { public: false, lan: false },
    require_user_verification: false,
    auto_pause: false,
    autosave_interval: 1000000,
    username: "", password: "", token: "", game_password: "",
    max_players: 1,
  }, null, 2));

  const save = join(SCRATCH, "testworld.zip");
  copyFileSync(savePath, save);
  return { config, settings, save };
}

// This binary is a Steam build: launched with --mp-connect (a real client, not --start-server) it
// calls SteamAPI_Init(), which - with no steam_appid.txt telling it its own app id - decides it was
// not launched through Steam and calls SteamAPI_RestartAppIfNecessary(), which quits immediately
// ("Steam requires game restart, restarting...") instead of connecting. Probed live: the headless
// --start-server path never hits this (no Steam API init at all), only the client path does.
// steam_appid.txt containing the app id, in the client's cwd, skips that check (Steam itself still
// needs to be running and logged in, which it already is for a normal desktop session).
const FACTORIO_STEAM_APPID = "427520";

/** Sets up the THIRD write-data root the client needs (server and your own game each hold one of
 *  the other two). Copies player-data.json from the real user dir so the client authenticates as
 *  the same account the save knows as game.players[1] - a fresh write-data has none, which would
 *  connect anonymously and land as a new player instead. Never logs the file's contents. */
function writeClientScratchFiles(binary: string): { config: string; writeDataDir: string; copiedPlayerData: boolean } {
  const writeDataDir = join(SCRATCH, "client-write-data");
  mkdirSync(writeDataDir, { recursive: true });

  const readData = resolve(binary, "../../data");
  const config = join(SCRATCH, "client-config.ini");
  writeFileSync(config, `[path]\nread-data=${readData}\nwrite-data=${writeDataDir}\n`);

  writeFileSync(join(SCRATCH, "steam_appid.txt"), FACTORIO_STEAM_APPID);

  const realPlayerData = join(FACTORIO_USER_DIR, "player-data.json");
  const copiedPlayerData = existsSync(realPlayerData);
  if (copiedPlayerData) {
    copyFileSync(realPlayerData, join(writeDataDir, "player-data.json"));
  }
  return { config, writeDataDir, copiedPlayerData };
}

async function waitForRCON(): Promise<{ playerName: string; hasCharacter: boolean; modVersion: string }> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    const client = new RCONClient({ host: "127.0.0.1", port: parseInt(RCON_PORT), password: RCON_PASSWORD });
    try {
      await client.connect();
      const res = await client.sendCommand(
        `/silent-command local p = game.players[1]; rcon.print(helpers.table_to_json({` +
        `name = p and p.name or "<none>", ` +
        `character = (p and p.character and p.character.valid) and true or false, ` +
        `mod = script.active_mods["ai-companion"]}))`
      );
      await client.disconnect();
      if (res.success && res.data) {
        const parsed = JSON.parse(res.data);
        return { playerName: parsed.name, hasCharacter: parsed.character, modVersion: parsed.mod };
      }
      lastError = res.error || "empty response";
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      try { await client.disconnect(); } catch { /* connect never completed */ }
    }
    await Bun.sleep(READY_POLL_MS);
  }
  throw new Error(`Test server did not become ready within ${READY_TIMEOUT_MS}ms. Last error: ${lastError}`);
}

interface PlayerSnapshot { index: number; name: string; connected: boolean; character: boolean }

function formatPlayers(players: PlayerSnapshot[]): string {
  if (!players.length) return "(no players reported)";
  return players.map((p) => `#${p.index} ${p.name} connected=${p.connected} character=${p.character}`).join("; ");
}

/** Polls until game.players[1] has a valid character (the client actually attached as the same
 *  player the save/arming logic reads), or times out. Reports every connected player and which
 *  index has a character on every poll, not just on timeout, so a mis-indexed connection - the
 *  main way this can silently fail to achieve anything - is diagnosable rather than mysterious. */
async function waitForCharacter(timeoutMs: number): Promise<{ hasCharacter: boolean; players: PlayerSnapshot[] }> {
  const deadline = Date.now() + timeoutMs;
  let lastPlayers: PlayerSnapshot[] = [];
  let lastError = "";
  while (Date.now() < deadline) {
    const client = new RCONClient({ host: "127.0.0.1", port: parseInt(RCON_PORT), password: RCON_PASSWORD });
    try {
      await client.connect();
      // pairs(), not # or ipairs(): game.players is a LuaCustomTable, not a plain array.
      const res = await client.sendCommand(
        `/silent-command local ps = {}; for index, p in pairs(game.players) do ps[#ps+1] = ` +
        `{index = index, name = p.name, connected = p.connected, ` +
        `character = (p.character and p.character.valid) and true or false} end; ` +
        `rcon.print(helpers.table_to_json(ps))`
      );
      await client.disconnect();
      if (res.success && res.data) {
        const parsed = JSON.parse(res.data);
        lastPlayers = Array.isArray(parsed) ? parsed : [];
        const p1 = lastPlayers.find((p) => p.index === 1);
        if (p1?.character) return { hasCharacter: true, players: lastPlayers };
      } else {
        lastError = res.error || "empty response";
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      try { await client.disconnect(); } catch { /* connect never completed */ }
    }
    console.log(`[test-server] waiting for client character... ${formatPlayers(lastPlayers)}`);
    await Bun.sleep(READY_POLL_MS);
  }
  throw new Error(
    `Client did not attach as game.players[1] with a valid character within ${timeoutMs}ms.\n` +
    `Connected players seen: ${formatPlayers(lastPlayers)}\n` +
    `Last RCON error (if any): ${lastError}\n` +
    `Likely cause: the client logged in under a different Factorio account than the save's ` +
    `game.players[1] expects (player-data.json missing or stale), so it connected as a new player ` +
    `instead of reusing that identity. Check ${join(SCRATCH, "client.log")} for connection errors first.`
  );
}

/** Resolves a CLI argument to a suite path: an explicit path, or a substring matched against the
 *  suites in scripts/smoke/ (so "t034" finds t034-nearest-resource.ts). */
function resolveSuite(arg: string): string {
  if (existsSync(arg)) return resolve(arg);
  const candidates = readdirSync(SMOKE_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "lib.ts" && f !== "test-server.ts" && f.includes(arg));
  if (candidates.length === 1) return join(SMOKE_DIR, candidates[0]!);
  if (candidates.length === 0) throw new Error(`No smoke suite matches "${arg}" in ${SMOKE_DIR}`);
  throw new Error(`"${arg}" is ambiguous - matches: ${candidates.join(", ")}`);
}

async function main() {
  const args = process.argv.slice(2);
  const serveOnly = args.includes("--serve");
  const keep = args.includes("--keep");
  const useClient = args.includes("--client");
  const saveFlagIdx = args.indexOf("--save");
  const explicitSave = saveFlagIdx !== -1 ? args[saveFlagIdx + 1] : undefined;
  // saveValueIdx is -1 (never a valid index) when --save is absent; using `saveFlagIdx + 1`
  // directly would silently swallow argv[0], i.e. the first suite name.
  const saveValueIdx = saveFlagIdx === -1 ? -1 : saveFlagIdx + 1;
  const suiteArgs = args.filter((a, i) => !a.startsWith("--") && i !== saveValueIdx);

  if (!serveOnly && suiteArgs.length === 0) {
    console.error("Usage: bun run scripts/smoke/test-server.ts [--serve] [--keep] [--client] [--save <path>] <suite> [suite...]");
    console.error("Suites may be paths or substrings, e.g. t034");
    console.error("--client attaches a real Factorio client, for combat suites (t021, t026, t051)");
    process.exit(2);
  }

  const binary = findFactorioBinary();
  const savePath = explicitSave ? resolve(explicitSave) : newestSave();
  const suites = suiteArgs.map(resolveSuite);

  console.log(`[test-server] binary : ${binary}`);
  console.log(`[test-server] save   : ${savePath}${explicitSave ? "" : "  (newest)"}`);
  console.log(`[test-server] ports  : game ${GAME_PORT}, rcon ${RCON_PORT} (both distinct from a normally-hosted game)`);

  await deployMod();
  const { config, settings, save } = writeScratchFiles(binary, savePath);

  const logPath = join(SCRATCH, "server.log");
  const logFd = openSync(logPath, "w");
  const proc = Bun.spawn([
    binary,
    "--start-server", save,
    "--config", config,
    "--mod-directory", MODS_DIR,
    "--server-settings", settings,
    "--port", GAME_PORT,
    "--rcon-bind", `127.0.0.1:${RCON_PORT}`,
    "--rcon-password", RCON_PASSWORD,
  ], { cwd: SCRATCH, stdout: logFd, stderr: logFd, stdin: "ignore" });

  console.log(`[test-server] started pid ${proc.pid}, log -> ${logPath}`);

  let clientProc: ReturnType<typeof Bun.spawn> | undefined;
  if (useClient) {
    const { config: clientConfig, writeDataDir, copiedPlayerData } = writeClientScratchFiles(binary);
    console.log(`[test-server] client write-data: ${writeDataDir}`);
    console.log(
      copiedPlayerData
        ? `[test-server] player-data.json: found and copied (client will authenticate as the same account as game.players[1])`
        : `[test-server] player-data.json: NOT FOUND at ${join(FACTORIO_USER_DIR, "player-data.json")} - client will connect anonymously and likely land as a NEW player, not players[1]`
    );

    const clientLogPath = join(SCRATCH, "client.log");
    const clientLogFd = openSync(clientLogPath, "w");
    clientProc = Bun.spawn([
      binary,
      "--mp-connect", `127.0.0.1:${GAME_PORT}`,
      "--config", clientConfig,
      "--mod-directory", MODS_DIR,
      "--disable-audio",
      "--window-size", "1024x768",
    ], { cwd: SCRATCH, stdout: clientLogFd, stderr: clientLogFd, stdin: "ignore" });
    console.log(`[test-server] client started pid ${clientProc.pid}, log -> ${clientLogPath}`);
  }

  let exitCode = 0;
  try {
    const ready = await waitForRCON();
    console.log(`[test-server] ready. mod=${ready.modVersion}  player=${ready.playerName}  character=${ready.hasCharacter}`);
    if (!ready.hasCharacter && !useClient) {
      console.log("[test-server] NOTE: no client connected, so game.players[1] has no character - companions will spawn UNARMED. Combat suites (t021, t026) need a connected client; mining/movement/world suites are unaffected.");
    }

    if (useClient) {
      const clientReady = await waitForCharacter(CLIENT_READY_TIMEOUT_MS);
      console.log(`[test-server] client attached. ${formatPlayers(clientReady.players)}`);
    }

    if (serveOnly) {
      console.log(`[test-server] --serve: staying up. RCON 127.0.0.1:${RCON_PORT} password "${RCON_PASSWORD}". Ctrl-C to stop.`);
      console.log(`[test-server] run a suite against it with:\n  FACTORIO_RCON_PORT=${RCON_PORT} FACTORIO_RCON_PASSWORD=${RCON_PASSWORD} bun run scripts/smoke/<suite>.ts`);
      await proc.exited;
    } else {
      for (const suite of suites) {
        console.log(`\n[test-server] ===== ${basename(suite)} =====`);
        const run = Bun.spawn(["bun", "run", suite], {
          cwd: REPO_ROOT,
          // The suite's own RCON and the MCP server it spawns must both reach THIS server, not a
          // normally-hosted game and not the repo .env's port.
          env: { ...process.env, FACTORIO_RCON_PORT: RCON_PORT, FACTORIO_RCON_PASSWORD: RCON_PASSWORD, FACTORIO_HOST: "127.0.0.1" },
          stdout: "inherit", stderr: "inherit",
        });
        const code = await run.exited;
        console.log(`[test-server] ${basename(suite)} exited ${code}`);
        if (code !== 0) exitCode = code;
      }
    }
  } finally {
    // Client torn down first (or alongside, under --keep) so a failure stopping it can never hide
    // a failure stopping the server - each step is wrapped so one does not swallow the other.
    if (clientProc) {
      if (keep) {
        console.log(`[test-server] --keep: leaving client pid ${clientProc.pid} running.`);
      } else {
        try {
          console.log(`[test-server] stopping client pid ${clientProc.pid}`);
          clientProc.kill();
          await clientProc.exited;
        } catch (e) {
          console.error(`[test-server] failed to stop client cleanly: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    if (keep) {
      console.log(`[test-server] --keep: leaving pid ${proc.pid} running and ${SCRATCH} in place.`);
    } else {
      try {
        console.log(`[test-server] stopping pid ${proc.pid}`);
        proc.kill();
        await proc.exited;
      } catch (e) {
        console.error(`[test-server] failed to stop server cleanly: ${e instanceof Error ? e.message : String(e)}`);
      }
      rmSync(SCRATCH, { recursive: true, force: true });
    }
  }

  process.exit(exitCode);
}

main();
