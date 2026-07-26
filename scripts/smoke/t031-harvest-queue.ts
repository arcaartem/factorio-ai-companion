// Live smoke test for T-031: "the harvest queue terminates on its own, tolerates the companion
// being walked away, and yields/resumes mining around a short in-reach hop" (factorio-mod
// commands/queues.lua tick_harvest_queues, this pass).
//
// Contract under test (see queues.lua's tick_harvest_queues, start_harvest, get_harvest_status,
// stop_harvest, and companion.lua's fac_companion_stop_all):
//   - harvested is counted every tick from a real main-inventory delta (not pinned at 0), so the
//     queue's own target check (harvested >= target) can actually fire and the queue clears
//     itself - no resource_mine_stop needed.
//   - The engine silently refuses to move a character whose mining_state.mining is true, so the
//     queue must yield: whenever a walk (or combat) queue is actively trying to move the
//     companion, mining_state is set to {mining = false} for that tick without touching q.current
//     - the partially-mined entity is not discarded, and the harvest queue itself is NOT stopped
//     just because the companion is walking.
//   - Reach is still enforced every tick via u.check_reach(cid, c, q.position, "resource"): once
//     the companion is genuinely too far from the ORIGINAL mining position, the queue aborts
//     itself (mining_state = false, queue dropped) - it does not walk back or hang forever.
//   - Once the walk ends and the companion is back in reach, if q.current.entity is still valid
//     but the engine isn't actively mining it (mining_state cleared by the yield above), the queue
//     re-asserts mining_state = {mining = true, position = entity.position} on that SAME entity
//     rather than treating it as abandoned - harvesting resumes without re-picking a fresh target.
//   - fac_companion_stop_all now also sets mining_state = {mining = false} explicitly (previously
//     only cleared storage.harvest_queues[id], leaving a mining companion stuck mining forever
//     with no queue behind it to ever un-set the engine's own mining_state).
//   - queues.start_harvest returns {error = "No resource"} when nothing is found under the
//     position - fac_resource_mine now surfaces that as a real {error=...} reply instead of the
//     old unconditional {mining:true, entities:0, status:"started"} success shape.
//   - The queue also advances across a depleted tile on its own (start_mining_next pops the next
//     closest entity within reach once q.current.entity goes invalid).
//
// STALE MOD CODE (see CLAUDE.md's "Update mod" / hot-reload gotchas): copying factorio-mod/ into
// the mods dir is NOT enough - a running game keeps executing the control-stage code it loaded at
// the last save load, so every behavioural check below would fail against it. `game.reload_script()`
// is reachable over RCON and returns success but does NOT reload the mod in a hosted multiplayer
// game (verified 2026-07-26); main menu -> Host Saved Game is the only reload path. `/fac_version`
// is no help either - it reads script.active_mods, pinned at app startup. So this suite prints a
// decisive behavioural stale/fresh banner before any scored check runs, and a report never has to
// guess which code a given log came from.
//
// Sections (all against companion 41, run in this order):
//   A. The queue terminates on its own (harvested rises, active -> false unaided, inventory
//      cross-check).
//   B. A mining companion can be walked away (real displacement, walking_state true at least
//      once, and the harvest queue self-terminates via reach-abort rather than lingering).
//   C. Yield-and-resume: a short in-reach hop pauses mining_state without killing the queue, and
//      mining resumes on its own afterward.
//   D. Regressions: stop_all clears mining_state, mining on ore-free ground is a real error, and
//      the queue advances across a depleted tile to a second one in range.
//   E. The resource_mine_until skill completes end-to-end, well under its own 30s per-attempt
//      timeout, against the same arena.
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t031-harvest-queue.ts
import { readFileSync } from "node:fs";
import { connectMCP, connectRCON, callTool, callToolRaw, check, summary, silent } from "./lib";
import { asArray } from "../../src/utils/connection";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Dedicated, otherwise-unused id: t019/t020/t024 use 1, t026 uses 21-24, t021/t022 use 1/31/32.
const HARVEST_ID = 41;

// Ore-arena candidates: 80-160 tiles from the world origin (not from wherever the companion
// happens to be standing right now) - the point is a location known in advance to be far from
// spawn-area infrastructure, independent of where this run's companion currently is.
const ARENA_ORIGIN = { x: 0, y: 0 };
const ARENA_CANDIDATE_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: 80, dy: 0 },
  { dx: 0, dy: 80 },
  { dx: -80, dy: 0 },
  { dx: 0, dy: -80 },
  { dx: 120, dy: 120 },
  { dx: -120, dy: 120 },
  { dx: 120, dy: -120 },
  { dx: -120, dy: -120 },
  { dx: 160, dy: 0 },
  { dx: 0, dy: 160 },
  { dx: -160, dy: 0 },
  { dx: 0, dy: -160 },
];
const ARENA_SAFETY_RADIUS = 30; // min distance from any enemy spawner/turret/worm (worms are prototype type="turret")
const ORE_CLEAR_RADIUS = 25; // min distance from any PRE-EXISTING resource entity, so this suite's own planted tiles are the only ore in the arena

// Local layout, all offsets from the chosen anchor (the found ARENA spot), well inside
// ORE_CLEAR_RADIUS so the pre-flight clear-check already covers them:
//   ORE_MAIN     anchor + (0, 0)   - generous pool, used by sections A/B/C/E
//   DEPLETE_A    anchor + (6, 0)   - tiny pool, depletes fast (section D check 12)
//   DEPLETE_B    anchor + (8, 0)   - generous pool, 2 tiles from DEPLETE_A (within its radius-3
//                                    seed search and within reach of a companion standing on A)
//   EMPTY_SPOT   anchor + (14, 0)  - deliberately ore-free ground (section D check 11 + the
//                                    stale/fresh banner)
const ORE_MAIN_AMOUNT = 1000;
const DEPLETE_A_AMOUNT = 2;
const DEPLETE_B_AMOUNT = 500;

const STATE_SAMPLE_RADIUS = 40; // generous: covers the full ~15-tile walk in section B from one anchor
const WALK_FAR_OFFSET = { dx: 0, dy: -15 }; // section B: clearly beyond resource_reach_distance (~2.7)
const WALK_SHORT_HOP = { dx: 0, dy: 2.2 }; // section C: > ARRIVE_DIST (1.5, forces a real walk queue) but <= resource reach (2.7) from ORE_MAIN

const TERMINATE_POLL_BUDGET_MS = 45000;
const WALK_POLL_BUDGET_MS = 40000;
const HOP_ARRIVE_BUDGET_MS = 15000;
const POLL_INTERVAL_MS = 1000;

const SKILL_POLL_BUDGET_MS = 60000; // generous outer safety net; the skill is expected to finish in a few seconds with ore already in reach
const SKILL_POLL_INTERVAL_MS = 1000;
const SKILL_WELL_UNDER_MS = 25000; // "well under" the skill's own 30s MINING_TIMEOUT

interface MineUntilSkillResult {
  skill: string;
  companionId: number;
  mined: number;
  target: number;
  success: boolean;
}

/** The three lifecycle outcomes pollUntilSkillDone can report (same convention as
 *  t022-reach-parity.ts) - kept distinct so a red run tells the reader WHICH diagnosis applies
 *  instead of every case reading as an identical `null`. */
type SkillPollOutcome = "timeout" | "no-result" | "done";

function findEntityNearLua(x: number, y: number, radius: number): string {
  return `
    local __player = game.players[1]
    local __target
    for _, e in ipairs(__player.surface.find_entities_filtered{name="character", position={x=${x}, y=${y}}, radius=${radius}}) do
      if e.valid and e ~= __player.character then __target = e; break end
    end
    if not __target then rcon.print(helpers.table_to_json({error = "companion not found"})); return end
  `;
}

/** Reads the trailing SKILL_RESULT line out of a background skill's log file. */
function parseSkillResultLog(logPath: string): MineUntilSkillResult | null {
  const content = readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const idx = line.indexOf("SKILL_RESULT ");
    if (idx !== -1) {
      return JSON.parse(line.slice(idx + "SKILL_RESULT ".length));
    }
  }
  return null;
}

async function pollUntilSkillDone(mcp: { client: any }, companionId: number): Promise<{ status: any; result: MineUntilSkillResult | null; outcome: SkillPollOutcome }> {
  const start = Date.now();
  let status: any = null;
  while (Date.now() - start < SKILL_POLL_BUDGET_MS) {
    status = await callTool(mcp.client, "companion_status", { companionId });
    if (status.skill?.running !== true && status.lastSkillResult) {
      const result = parseSkillResultLog(status.lastSkillResult.logPath);
      return { status, result, outcome: result !== null ? "done" : "no-result" };
    }
    await sleep(SKILL_POLL_INTERVAL_MS);
  }
  return { status, result: null, outcome: "timeout" };
}

interface ArenaSpot {
  found: boolean;
  x?: number;
  y?: number;
}

/** Finds a spot clear of BOTH enemy spawners/turrets/worms (ARENA_SAFETY_RADIUS) and any
 *  pre-existing resource entity (ORE_CLEAR_RADIUS), so this suite's own planted ore tiles are
 *  the only ore anywhere near the arena - required for the "ground with no ore" check (D11) and
 *  for resource_nearest (section E) to unambiguously find OUR tile rather than a natural patch. */
async function findSafeOreArenaSpot(rcon: { send: (cmd: string) => Promise<string> }, ref: { x: number; y: number }): Promise<ArenaSpot> {
  const offsetsLua = ARENA_CANDIDATE_OFFSETS.map((o) => `{dx=${o.dx}, dy=${o.dy}}`).join(", ");
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local candidates = {${offsetsLua}}
      local ref = {x = ${ref.x}, y = ${ref.y}}
      local chosen_x, chosen_y
      for _, c in ipairs(candidates) do
        local px, py = ref.x + c.dx, ref.y + c.dy
        local enemies = surface.find_entities_filtered{type={"unit-spawner", "turret"}, force="enemy", position={x=px, y=py}, radius=${ARENA_SAFETY_RADIUS}}
        local resources = surface.find_entities_filtered{type="resource", position={x=px, y=py}, radius=${ORE_CLEAR_RADIUS}}
        if #enemies == 0 and #resources == 0 then
          local pos = surface.find_non_colliding_position("character", {x=px, y=py}, 10, 1)
          if pos then chosen_x, chosen_y = pos.x, pos.y; break end
        end
      end
      if chosen_x then
        rcon.print(helpers.table_to_json({found = true, x = chosen_x, y = chosen_y}))
      else
        rcon.print(helpers.table_to_json({found = false}))
      end
    `
  );
  return JSON.parse(raw);
}

interface OreTileResult {
  created: boolean;
  x?: number;
  y?: number;
}

/** Plants one iron-ore tile at (approximately) `pos`, snapped onto valid ground first. Returns the
 *  entity's REAL position, which is the teardown key: resource entities carry no `unit_number`
 *  (it is nil for simple entities), so identity-by-unit_number silently tracks nothing and leaves
 *  every planted tile behind in the player's world. Position is exact here because the arena spot
 *  is verified clear of pre-existing resources before anything is planted. */
async function placeOreTile(rcon: { send: (cmd: string) => Promise<string> }, pos: { x: number; y: number }, amount: number): Promise<OreTileResult> {
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local spot = surface.find_non_colliding_position("iron-ore", {x=${pos.x}, y=${pos.y}}, 5, 0.5) or {x=${pos.x}, y=${pos.y}}
      local e = surface.create_entity{name="iron-ore", amount=${amount}, position=spot}
      if e and e.valid then
        rcon.print(helpers.table_to_json({created = true, x = e.position.x, y = e.position.y}))
      else
        rcon.print(helpers.table_to_json({created = false}))
      end
    `
  );
  const parsed = JSON.parse(raw);
  return { created: parsed.created === true, x: parsed.x, y: parsed.y };
}

/** Destroys the iron-ore tiles this suite planted, matched at their exact recorded positions so an
 *  unrelated resource entity is never touched. No-op for tiles already gone (mined out). */
async function destroyOreTiles(rcon: { send: (cmd: string) => Promise<string> }, positions: { x: number; y: number }[]): Promise<{ destroyed: number }> {
  if (positions.length === 0) return { destroyed: 0 };
  const posListLua = positions.map((p) => `{x=${p.x}, y=${p.y}}`).join(", ");
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local destroyed = 0
      for _, p in ipairs({${posListLua}}) do
        for _, r in ipairs(surface.find_entities_filtered{type="resource", name="iron-ore", position=p, radius=0.5}) do
          if r.valid then r.destroy(); destroyed = destroyed + 1 end
        end
      end
      rcon.print(helpers.table_to_json({destroyed = destroyed}))
    `
  );
  return JSON.parse(raw);
}

/** Teleports the companion currently near (curX, curY) to (destX, destY), snapped onto valid
 *  ground. Test-harness-only, per CLAUDE.md's convention (spawning/teleporting is sanctioned in
 *  harnesses, never in the mod's own gameplay code). `lookupRadius` is generous by default since a
 *  companion mid-walk-test can be well away from where it was last known to be. */
async function teleportCompanion(
  rcon: { send: (cmd: string) => Promise<string> },
  curX: number,
  curY: number,
  destX: number,
  destY: number,
  lookupRadius = STATE_SAMPLE_RADIUS
): Promise<{ teleported: boolean; x?: number; y?: number }> {
  const raw = await silent(
    rcon,
    findEntityNearLua(curX, curY, lookupRadius) +
      `
      local dest = __target.surface.find_non_colliding_position("character", {x=${destX}, y=${destY}}, 5, 0.5) or {x=${destX}, y=${destY}}
      local teleported = __target.teleport(dest)
      rcon.print(helpers.table_to_json({teleported = teleported, x = dest.x, y = dest.y}))
    `
  );
  return JSON.parse(raw);
}

interface CompanionState {
  found: boolean;
  x?: number;
  y?: number;
  mining?: boolean;
  walking?: boolean;
}

/** One side-channel call giving position + mining_state.mining + walking_state.walking together -
 *  the ground truth this whole suite cross-checks the MCP-reported queue status against. Anchored
 *  at a generous fixed radius so repeated sampling during a ~15-tile walk doesn't need to
 *  re-target between calls. */
async function sampleCompanionState(rcon: { send: (cmd: string) => Promise<string> }, anchorX: number, anchorY: number, radius = STATE_SAMPLE_RADIUS): Promise<CompanionState> {
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local target
      for _, e in ipairs(surface.find_entities_filtered{name="character", position={x=${anchorX}, y=${anchorY}}, radius=${radius}}) do
        if e.valid and e ~= game.players[1].character then target = e; break end
      end
      if not target then rcon.print(helpers.table_to_json({found = false})); return end
      local mining = target.mining_state and target.mining_state.mining or false
      local walking = target.walking_state and target.walking_state.walking or false
      rcon.print(helpers.table_to_json({found = true, x = target.position.x, y = target.position.y, mining = mining, walking = walking}))
    `
  );
  return JSON.parse(raw);
}

/** Reads a companion's main-inventory count for one item, by side channel - ground truth
 *  independent of anything resource_mine/resource_mine_status itself claims. */
async function readInventoryCount(rcon: { send: (cmd: string) => Promise<string> }, x: number, y: number, itemName: string, radius = STATE_SAMPLE_RADIUS): Promise<number> {
  const raw = await silent(
    rcon,
    findEntityNearLua(x, y, radius) +
      `
      local count = __target.get_inventory(defines.inventory.character_main).get_item_count("${itemName}")
      rcon.print(helpers.table_to_json({count = count}))
    `
  );
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`readInventoryCount(${x}, ${y}, ${itemName}) could not find the companion: ${raw}`);
  return parsed.count;
}

/** Destroys any item-on-ground entities near (x, y) - used right after companion_disappear
 *  spills inventory/equipment (companion.lua's spill_inventory), same convention as t022/t021. */
async function destroyGroundResidue(rcon: { send: (cmd: string) => Promise<string> }, x: number, y: number): Promise<number> {
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local destroyed = 0
      for _, e in ipairs(surface.find_entities_filtered{type="item-entity", position={x=${x}, y=${y}}, radius=5}) do
        if e.valid then e.destroy(); destroyed = destroyed + 1 end
      end
      rcon.print(helpers.table_to_json({destroyed = destroyed}))
    `
  );
  return JSON.parse(raw).destroyed;
}

/** Removes any companion at `id` still alive from a previous run (or, in teardown, this run's
 *  own) - fac_companion_disappear clears storage.companions[id] unconditionally, so a subsequent
 *  companion_spawn takes the fresh-spawn branch rather than the {status:"exists"} no-op that
 *  skips spawn-time work entirely (T-026's root cause). */
async function clearStaleCompanion(mcp: { client: any }, rcon: { send: (cmd: string) => Promise<string> }, id: number): Promise<void> {
  const posRes = await callTool(mcp.client, "companion_position", { companionId: id });
  if (!posRes?.position) {
    console.log(`Stale-companion cleanup: no companion ${id} present (clean start).`);
    return;
  }
  const disappear = await callTool(mcp.client, "companion_disappear", { companionId: id });
  console.log(`Stale-companion cleanup: removed companion ${id} ->`, JSON.stringify(disappear));
  const dropped = asArray<{ name: string; count: number }>(disappear?.dropped);
  if (dropped.length > 0) {
    const destroyed = await destroyGroundResidue(rcon, posRes.position.x, posRes.position.y);
    console.log(`Stale-companion cleanup: destroyed ${destroyed} ground residue entities spilled by companion ${id} (${JSON.stringify(dropped)})`);
  }
}

/** Runs one independent section, converting an unexpected throw into a failed check instead of
 *  aborting the whole suite (t022's convention) - a throw in one section must not silently hide
 *  every later section from the report. */
async function runSection(label: string, banner: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  try {
    await body();
  } catch (e) {
    check(`${label}: section ran to completion without an unexpected throw`, false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
  }
}

async function main() {
  const mcp = await connectMCP();
  const rcon = await connectRCON();

  const plantedOrePositions: { x: number; y: number }[] = []; // pushed as soon as each tile is planted, so cleanup can always find them even if setup throws partway through

  try {
    // -----------------------------------------------------------
    // Setup: companion 41, fresh
    // -----------------------------------------------------------
    console.log("\n=== Setup: companion 41 ===");
    await clearStaleCompanion(mcp, rcon, HARVEST_ID);
    const spawnRes = await callTool(mcp.client, "companion_spawn", { companionId: HARVEST_ID });
    console.log("companion_spawn (41) ->", JSON.stringify(spawnRes));
    check("Setup: companion 41 spawned genuinely fresh (spawned:true, not status:'exists')", spawnRes.spawned === true, JSON.stringify(spawnRes));
    if (spawnRes.spawned !== true) {
      throw new Error(`Companion ${HARVEST_ID} did not spawn fresh (${JSON.stringify(spawnRes)}) - aborting, every downstream check would be meaningless.`);
    }

    // -----------------------------------------------------------
    // Setup: constructed ore arena (never trust the live map - see CLAUDE.md's smoke-test convention)
    // -----------------------------------------------------------
    console.log("\n=== Setup: constructed ore arena ===");
    const arenaSpot = await findSafeOreArenaSpot(rcon, ARENA_ORIGIN);
    console.log("Arena spot ->", JSON.stringify(arenaSpot));
    check("Setup: found an arena spot 80-160 tiles out, clear of spawners/turrets/worms AND clear of any pre-existing resource", arenaSpot.found === true, JSON.stringify(arenaSpot));
    if (!arenaSpot.found) {
      throw new Error(`No safe ore-arena spot found (${JSON.stringify(arenaSpot)}) - aborting, nothing downstream can run without a controlled arena.`);
    }
    const anchor = { x: arenaSpot.x!, y: arenaSpot.y! };

    const oreMain = await placeOreTile(rcon, anchor, ORE_MAIN_AMOUNT);
    console.log("ORE_MAIN ->", JSON.stringify(oreMain));
    if (oreMain.created) plantedOrePositions.push({ x: oreMain.x!, y: oreMain.y! });
    check(`Setup: ORE_MAIN planted (iron-ore x${ORE_MAIN_AMOUNT})`, oreMain.created === true, JSON.stringify(oreMain));

    const depleteA = await placeOreTile(rcon, { x: anchor.x + 6, y: anchor.y }, DEPLETE_A_AMOUNT);
    console.log("DEPLETE_A ->", JSON.stringify(depleteA));
    if (depleteA.created) plantedOrePositions.push({ x: depleteA.x!, y: depleteA.y! });
    check(`Setup: DEPLETE_A planted (iron-ore x${DEPLETE_A_AMOUNT}, meant to run out fast)`, depleteA.created === true, JSON.stringify(depleteA));

    const depleteB = await placeOreTile(rcon, { x: anchor.x + 8, y: anchor.y }, DEPLETE_B_AMOUNT);
    console.log("DEPLETE_B ->", JSON.stringify(depleteB));
    if (depleteB.created) plantedOrePositions.push({ x: depleteB.x!, y: depleteB.y! });
    check(`Setup: DEPLETE_B planted (iron-ore x${DEPLETE_B_AMOUNT}, 2 tiles from DEPLETE_A, in reach of a companion standing on it)`, depleteB.created === true, JSON.stringify(depleteB));

    if (!oreMain.created || !depleteA.created || !depleteB.created) {
      throw new Error("Not all arena ore tiles could be planted - aborting, sections A-E all depend on this exact layout.");
    }

    const oreMainPos = { x: oreMain.x!, y: oreMain.y! };
    const depleteAPos = { x: depleteA.x!, y: depleteA.y! };
    const emptySpot = { x: anchor.x + 14, y: anchor.y };

    // -----------------------------------------------------------
    // Stale/fresh discriminator banner - printed before any behavioural check runs, so a report
    // never has to guess which code a given log came from (see header comment).
    // -----------------------------------------------------------
    // Anchor every lookup on the companion's LIVE position. Anchoring on where it is merely
    // expected to be chains failures: the companion spawns next to the player, ~90 tiles from
    // the arena, so a fixed arena-relative anchor never finds it and each later section then
    // anchors on a teleport that never happened.
    const posBeforeBanner = await callTool(mcp.client, "companion_position", { companionId: HARVEST_ID });
    const tpBanner = await teleportCompanion(rcon, posBeforeBanner.position.x, posBeforeBanner.position.y, emptySpot.x, emptySpot.y);
    console.log("Banner setup: teleport onto EMPTY_SPOT ->", JSON.stringify(tpBanner));
    const bannerRes = await callTool(mcp.client, "resource_mine", { companionId: HARVEST_ID, x: emptySpot.x, y: emptySpot.y, count: 3, resourceName: "iron-ore" });
    console.log("Banner: resource_mine on ore-free ground ->", JSON.stringify(bannerRes));
    const looksFresh = bannerRes?.error === "No resource";
    const looksStale = bannerRes?.mining === true && bannerRes?.entities === 0;
    console.log(
      `\n########## MOD CODE BANNER ##########\n` +
        (looksFresh
          ? "FRESH CODE: resource_mine on ore-free ground returned {error:'No resource'} - the fix is loaded, behavioural checks below are meaningful."
          : looksStale
          ? "STALE CODE: resource_mine on ore-free ground returned {mining:true, entities:0, status:'started'} - the OLD behaviour is still running. Behavioural checks below are EXPECTED TO FAIL until the save is re-hosted (see CLAUDE.md's mod hot-reload gotcha)."
          : `UNRECOGNIZED: response matched neither the known fresh nor stale shape - inspect manually: ${JSON.stringify(bannerRes)}`) +
        `\n######################################\n`
    );

    // -----------------------------------------------------------
    // Section A: the queue terminates on its own
    // -----------------------------------------------------------
    await runSection("A", "The harvest queue terminates on its own (Done-when, half 1)", async () => {
      const posBeforeA = await callTool(mcp.client, "companion_position", { companionId: HARVEST_ID });
      const tpA = await teleportCompanion(rcon, posBeforeA.position.x, posBeforeA.position.y, oreMainPos.x, oreMainPos.y);
      console.log("A setup: teleport onto ORE_MAIN ->", JSON.stringify(tpA));
      check("A setup: companion teleported onto ORE_MAIN", tpA.teleported === true, JSON.stringify(tpA));

      const oreBeforeA = await readInventoryCount(rcon, oreMainPos.x, oreMainPos.y, "iron-ore");

      const mineStartA = await callTool(mcp.client, "resource_mine", { companionId: HARVEST_ID, x: oreMainPos.x, y: oreMainPos.y, count: 5, resourceName: "iron-ore" });
      console.log("A1: resource_mine (start) ->", JSON.stringify(mineStartA));
      check("A1: resource_mine on the in-reach, ore-rich tile is accepted (mining:true)", mineStartA?.mining === true, JSON.stringify(mineStartA));

      const harvestSeries: number[] = [];
      let selfTerminated = false;
      let terminalStatusA: any = null;
      const pollStartA = Date.now();
      while (Date.now() - pollStartA < TERMINATE_POLL_BUDGET_MS) {
        const status = await callTool(mcp.client, "resource_mine_status", { companionId: HARVEST_ID });
        if (status?.status?.active !== true) {
          selfTerminated = true;
          terminalStatusA = status?.status;
          break;
        }
        harvestSeries.push(status?.status?.harvested ?? -1);
        await sleep(POLL_INTERVAL_MS);
      }
      // finalHarvested comes from the TERMINAL status, not the last active poll: the queue's own
      // target check and its removal happen on the same tick, so an active poll never observes
      // harvested == target - only the terminal read can carry the true final count.
      const finalHarvested = terminalStatusA?.harvested ?? -1;
      console.log(`A2/A3: harvested series (self-terminated=${selfTerminated}) ->`, JSON.stringify(harvestSeries), "terminal ->", JSON.stringify(terminalStatusA));

      let nonDecreasing = true;
      for (let i = 1; i < harvestSeries.length; i++) {
        if (harvestSeries[i]! < harvestSeries[i - 1]!) nonDecreasing = false;
      }
      check(
        "A2 (Done-when): harvested strictly rises over time - non-decreasing series with a strictly-greater final value (the old code pinned this at 0)",
        nonDecreasing && finalHarvested > (harvestSeries[0] ?? -1),
        JSON.stringify({ series: harvestSeries, finalHarvested })
      );
      check(
        "A3 (Done-when): the queue reached active:false on its own within 45s, with no resource_mine_stop ever called",
        selfTerminated,
        selfTerminated ? `terminated after ${Date.now() - pollStartA}ms` : `still active after ${TERMINATE_POLL_BUDGET_MS}ms poll budget`
      );
      check(
        "A3: terminal status reports reason 'target_reached'",
        terminalStatusA?.reason === "target_reached",
        JSON.stringify(terminalStatusA)
      );

      const oreAfterA = await readInventoryCount(rcon, oreMainPos.x, oreMainPos.y, "iron-ore");
      const deltaA = oreAfterA - oreBeforeA;
      check(
        "A4: independent side-channel inventory delta equals the reported final harvested count (counter-honesty check - the old code reported 0 while inventory rose)",
        deltaA === finalHarvested,
        JSON.stringify({ before: oreBeforeA, after: oreAfterA, delta: deltaA, reportedFinal: finalHarvested })
      );
    });

    // -----------------------------------------------------------
    // Section B: a mining companion can be walked away
    // -----------------------------------------------------------
    await runSection("B", "A mining companion can be walked away (Done-when, half 2)", async () => {
      await callToolRaw(mcp.client, "companion_stop_all", { companionId: HARVEST_ID });
      const posBeforeB = await callTool(mcp.client, "companion_position", { companionId: HARVEST_ID });
      const tpB = await teleportCompanion(rcon, posBeforeB.position.x, posBeforeB.position.y, oreMainPos.x, oreMainPos.y);
      console.log("B setup: teleport onto ORE_MAIN ->", JSON.stringify(tpB));
      check("B setup: companion teleported onto ORE_MAIN", tpB.teleported === true, JSON.stringify(tpB));

      const mineStartB = await callTool(mcp.client, "resource_mine", { companionId: HARVEST_ID, x: oreMainPos.x, y: oreMainPos.y, count: 30, resourceName: "iron-ore" });
      console.log("B5: resource_mine (start, target 30 so the queue outlives the walk) ->", JSON.stringify(mineStartB));
      check("B5 setup: resource_mine accepted", mineStartB?.mining === true, JSON.stringify(mineStartB));

      const stateB0 = await sampleCompanionState(rcon, oreMainPos.x, oreMainPos.y);
      const statusB0 = await callTool(mcp.client, "resource_mine_status", { companionId: HARVEST_ID });
      console.log("B5: side-channel state right after start ->", JSON.stringify(stateB0), "| queue status ->", JSON.stringify(statusB0));
      check("B5: harvest queue reports active:true right after starting", statusB0?.status?.active === true, JSON.stringify(statusB0));
      check("B5: side channel confirms mining_state.mining is true right after starting", stateB0.mining === true, JSON.stringify(stateB0));

      const walkTargetB = { x: oreMainPos.x + WALK_FAR_OFFSET.dx, y: oreMainPos.y + WALK_FAR_OFFSET.dy };
      const walkSnapRaw = await silent(rcon, `local pos = game.players[1].surface.find_non_colliding_position("character", {x=${walkTargetB.x}, y=${walkTargetB.y}}, 10, 0.5) or {x=${walkTargetB.x}, y=${walkTargetB.y}}; rcon.print(helpers.table_to_json({x=pos.x, y=pos.y}))`);
      const walkSnap = JSON.parse(walkSnapRaw);
      console.log(`B6: raw /fac_move_to ${HARVEST_ID} ${walkSnap.x} ${walkSnap.y} (NOT the MCP move_to tool - that auto-stops mining)`);
      const rawMoveStart = await rcon.send(`/fac_move_to ${HARVEST_ID} ${walkSnap.x} ${walkSnap.y}`);
      console.log("B6: raw move_to response ->", rawMoveStart);

      const startPosB = { x: stateB0.x!, y: stateB0.y! };
      let sawWalkingTrue = false;
      let lastPosB = startPosB;
      let harvestSelfTerminatedB = false;
      let terminalStatusB: any = null;
      const pollStartB = Date.now();
      while (Date.now() - pollStartB < WALK_POLL_BUDGET_MS) {
        const stateB = await sampleCompanionState(rcon, oreMainPos.x, oreMainPos.y);
        if (stateB.found && stateB.walking === true) sawWalkingTrue = true;
        if (stateB.found) lastPosB = { x: stateB.x!, y: stateB.y! };
        const statusB = await callTool(mcp.client, "resource_mine_status", { companionId: HARVEST_ID });
        if (statusB?.status?.active !== true) {
          harvestSelfTerminatedB = true;
          terminalStatusB = statusB?.status;
          console.log(`B8: harvest queue reached active:false after ${Date.now() - pollStartB}ms (reach-abort expected)`);
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }
      const displacementB = dist(startPosB, lastPosB);
      console.log(`B7: displacement over the walk -> ${displacementB.toFixed(2)} tiles (start ${JSON.stringify(startPosB)} -> last ${JSON.stringify(lastPosB)})`);

      check(
        "B7 (Done-when): net displacement over the walk is clearly nonzero (the old code moved 0.000 tiles while mining pinned the companion)",
        displacementB > 3,
        `displacement=${displacementB.toFixed(2)} tiles`
      );
      check("B7: walking_state.walking read true at least once during the walk", sawWalkingTrue, `sawWalkingTrue=${sawWalkingTrue}`);
      check(
        "B8 (Done-when): the harvest queue terminated on its own (reach-abort) rather than lingering forever once the companion left resource reach",
        harvestSelfTerminatedB,
        harvestSelfTerminatedB ? "terminated" : `still active after ${WALK_POLL_BUDGET_MS}ms poll budget`
      );
      check(
        "B8: terminal status reports reason 'too_far'",
        terminalStatusB?.reason === "too_far",
        JSON.stringify(terminalStatusB)
      );

      // Cleanup for this section: stop movement so the next section starts from a known state.
      await rcon.send(`/fac_move_stop ${HARVEST_ID}`);
      await callToolRaw(mcp.client, "companion_stop_all", { companionId: HARVEST_ID });
    });

    // -----------------------------------------------------------
    // Section C: yield-and-resume
    // -----------------------------------------------------------
    await runSection("C", "Yield-and-resume around a short in-reach hop", async () => {
      const posBeforeC = await callTool(mcp.client, "companion_position", { companionId: HARVEST_ID });
      const tpC = await teleportCompanion(rcon, posBeforeC.position.x, posBeforeC.position.y, oreMainPos.x, oreMainPos.y);
      console.log("C setup: teleport back onto ORE_MAIN ->", JSON.stringify(tpC));
      check("C setup: companion teleported onto ORE_MAIN", tpC.teleported === true, JSON.stringify(tpC));

      const mineStartC = await callTool(mcp.client, "resource_mine", { companionId: HARVEST_ID, x: oreMainPos.x, y: oreMainPos.y, count: 20, resourceName: "iron-ore" });
      console.log("C9: resource_mine (start) ->", JSON.stringify(mineStartC));
      check("C9 setup: resource_mine accepted", mineStartC?.mining === true, JSON.stringify(mineStartC));

      // Let a little real mining happen before the hop, so "continues to rise" has a genuine
      // before-hop baseline rather than comparing against 0.
      await sleep(3000);
      const statusBeforeHop = await callTool(mcp.client, "resource_mine_status", { companionId: HARVEST_ID });
      const harvestedBeforeHop = statusBeforeHop?.status?.harvested ?? 0;
      console.log("C9: harvested before the hop ->", harvestedBeforeHop);

      const hopTarget = { x: oreMainPos.x + WALK_SHORT_HOP.dx, y: oreMainPos.y + WALK_SHORT_HOP.dy };
      console.log(`C9: raw /fac_move_to ${HARVEST_ID} ${hopTarget.x} ${hopTarget.y} (short in-reach hop, NOT the MCP move_to tool)`);
      await rcon.send(`/fac_move_to ${HARVEST_ID} ${hopTarget.x} ${hopTarget.y}`);

      // Poll the raw move (idempotent per move.lua's start_walk) until it reports arrival.
      let arrivedHop = false;
      const hopStart = Date.now();
      while (Date.now() - hopStart < HOP_ARRIVE_BUDGET_MS) {
        const moveStatus = JSON.parse(await rcon.send(`/fac_move_to ${HARVEST_ID} ${hopTarget.x} ${hopTarget.y}`));
        if (moveStatus?.active === false) {
          arrivedHop = true;
          break;
        }
        await sleep(500);
      }
      console.log(`C9: hop arrived=${arrivedHop} after ${Date.now() - hopStart}ms`);
      check("C setup: the short in-reach hop completed (arrived) within budget", arrivedHop, `arrived=${arrivedHop}`);

      // Give the queue a moment to re-assert mining_state on the resumed tile.
      await sleep(2000);
      const stateAfterHop = await sampleCompanionState(rcon, oreMainPos.x, oreMainPos.y);
      console.log("C9: side-channel state after hop ->", JSON.stringify(stateAfterHop));
      check("C9 (Done-when): mining_state.mining reads true again after the hop (resumed on the same entity)", stateAfterHop.mining === true, JSON.stringify(stateAfterHop));

      await sleep(4000);
      const statusAfterHop = await callTool(mcp.client, "resource_mine_status", { companionId: HARVEST_ID });
      const harvestedAfterHop = statusAfterHop?.status?.harvested ?? 0;
      console.log("C9: harvested after the hop ->", harvestedAfterHop, "(queue status:", JSON.stringify(statusAfterHop), ")");
      check(
        "C9 (Done-when): harvested continued rising after the hop - mining genuinely resumed, not just a stale mining_state flag",
        harvestedAfterHop > harvestedBeforeHop,
        JSON.stringify({ harvestedBeforeHop, harvestedAfterHop })
      );

      // This queue's target (20) likely isn't reached yet - stop it explicitly so section D
      // starts from a clean, known state (does not reuse this queue).
      const stopC = await callTool(mcp.client, "resource_mine_stop", { companionId: HARVEST_ID });
      console.log("C teardown: resource_mine_stop ->", JSON.stringify(stopC));
    });

    // -----------------------------------------------------------
    // Section D: regressions
    // -----------------------------------------------------------
    await runSection("D", "Regressions this fix also closes", async () => {
      // D10: stop_all mid-harvest leaves mining_state.mining false.
      const posBeforeD10 = await callTool(mcp.client, "companion_position", { companionId: HARVEST_ID });
      const tpD10 = await teleportCompanion(rcon, posBeforeD10.position.x, posBeforeD10.position.y, oreMainPos.x, oreMainPos.y);
      check("D10 setup: companion teleported onto ORE_MAIN", tpD10.teleported === true, JSON.stringify(tpD10));

      const mineStartD10 = await callTool(mcp.client, "resource_mine", { companionId: HARVEST_ID, x: oreMainPos.x, y: oreMainPos.y, count: 30, resourceName: "iron-ore" });
      console.log("D10: resource_mine (start) ->", JSON.stringify(mineStartD10));
      check("D10 setup: resource_mine accepted", mineStartD10?.mining === true, JSON.stringify(mineStartD10));
      await sleep(1500);

      const stopAllD10 = await callTool(mcp.client, "companion_stop_all", { companionId: HARVEST_ID });
      console.log("D10: companion_stop_all ->", JSON.stringify(stopAllD10));

      const stateAfterStopAll = await sampleCompanionState(rcon, oreMainPos.x, oreMainPos.y);
      console.log("D10: side-channel state after stop_all ->", JSON.stringify(stateAfterStopAll));
      check(
        "D10 (regression): fac_companion_stop_all mid-harvest leaves mining_state.mining FALSE (the old code left the character mining forever)",
        stateAfterStopAll.mining === false,
        JSON.stringify(stateAfterStopAll)
      );
      const statusAfterStopAllD10 = await callTool(mcp.client, "resource_mine_status", { companionId: HARVEST_ID });
      check("D10: resource_mine_status also reads active:false after stop_all (queue was cleared)", statusAfterStopAllD10?.status?.active !== true, JSON.stringify(statusAfterStopAllD10));

      // D11: mining on ore-free ground is a real error (reusing the same call the startup
      // banner made, scored here as its own check for section-D narrative ordering).
      const posBeforeD11 = await callTool(mcp.client, "companion_position", { companionId: HARVEST_ID });
      const tpD11 = await teleportCompanion(rcon, posBeforeD11.position.x, posBeforeD11.position.y, emptySpot.x, emptySpot.y);
      check("D11 setup: companion teleported onto EMPTY_SPOT", tpD11.teleported === true, JSON.stringify(tpD11));
      const mineEmptyD11 = await callTool(mcp.client, "resource_mine", { companionId: HARVEST_ID, x: emptySpot.x, y: emptySpot.y, count: 3, resourceName: "iron-ore" });
      console.log("D11: resource_mine on ore-free ground ->", JSON.stringify(mineEmptyD11));
      check(
        "D11 (regression): resource_mine on ground with no ore returns a real {error:...}, decisively NOT {mining:true, status:'started'}",
        mineEmptyD11?.mining !== true && typeof mineEmptyD11?.error === "string",
        JSON.stringify(mineEmptyD11)
      );

      // D12: the queue advances across a depleted tile to a second one in range.
      const posBeforeD12 = await callTool(mcp.client, "companion_position", { companionId: HARVEST_ID });
      const tpD12 = await teleportCompanion(rcon, posBeforeD12.position.x, posBeforeD12.position.y, depleteAPos.x, depleteAPos.y);
      check("D12 setup: companion teleported onto DEPLETE_A", tpD12.teleported === true, JSON.stringify(tpD12));

      const depleteTarget = DEPLETE_A_AMOUNT + 3; // strictly more than DEPLETE_A alone can supply
      const mineDepleteD12 = await callTool(mcp.client, "resource_mine", { companionId: HARVEST_ID, x: depleteAPos.x, y: depleteAPos.y, count: depleteTarget, resourceName: "iron-ore" });
      console.log("D12: resource_mine (start, target > DEPLETE_A's own pool) ->", JSON.stringify(mineDepleteD12));
      check("D12 setup: resource_mine accepted", mineDepleteD12?.mining === true, JSON.stringify(mineDepleteD12));

      let harvestedD12 = 0;
      let terminatedD12 = false;
      let terminalStatusD12: any = null;
      const pollStartD12 = Date.now();
      while (Date.now() - pollStartD12 < TERMINATE_POLL_BUDGET_MS) {
        const statusD12 = await callTool(mcp.client, "resource_mine_status", { companionId: HARVEST_ID });
        if (statusD12?.status?.active !== true) {
          terminatedD12 = true;
          terminalStatusD12 = statusD12?.status;
          break;
        }
        harvestedD12 = statusD12?.status?.harvested ?? harvestedD12;
        await sleep(POLL_INTERVAL_MS);
      }
      // The queue's target check and its removal happen on the same tick, so the last ACTIVE
      // poll is always below target - only the TERMINAL status can show the true final count.
      harvestedD12 = terminalStatusD12?.harvested ?? harvestedD12;
      console.log(`D12: terminated=${terminatedD12}, harvested=${harvestedD12}, target=${depleteTarget}`);
      check("D12: the queue terminated (didn't hang) within budget after crossing a depleted tile", terminatedD12, `terminated=${terminatedD12} after ${Date.now() - pollStartD12}ms`);
      check(
        "D12 (Done-when): harvested exceeds DEPLETE_A's own pool - the queue genuinely advanced to DEPLETE_B rather than stopping when the first tile ran dry",
        harvestedD12 > DEPLETE_A_AMOUNT,
        JSON.stringify({ harvestedD12, depleteAAmount: DEPLETE_A_AMOUNT, target: depleteTarget })
      );
      check("D12: harvested reached the requested target (>= target) once DEPLETE_B was available", harvestedD12 >= depleteTarget, JSON.stringify({ harvestedD12, target: depleteTarget }));
    });

    // -----------------------------------------------------------
    // Section E: the skill, end to end
    // -----------------------------------------------------------
    await runSection("E", "resource_mine_until completes end-to-end, well under its own timeout", async () => {
      await callToolRaw(mcp.client, "companion_stop_all", { companionId: HARVEST_ID });
      const posBeforeE = await callTool(mcp.client, "companion_position", { companionId: HARVEST_ID });
      const tpE = await teleportCompanion(rcon, posBeforeE.position.x, posBeforeE.position.y, oreMainPos.x, oreMainPos.y);
      check("E setup: companion teleported onto ORE_MAIN (so resource_nearest unambiguously finds our own planted tile)", tpE.teleported === true, JSON.stringify(tpE));

      const skillStartTime = Date.now();
      const startE = await callToolRaw(mcp.client, "resource_mine_until", { companionId: HARVEST_ID, resource: "iron", amount: 5 });
      console.log("E13: resource_mine_until (start) ->", startE);

      const { status: statusE, result: resultE, outcome: outcomeE } = await pollUntilSkillDone(mcp, HARVEST_ID);
      const elapsedE = Date.now() - skillStartTime;
      console.log(`E13: skill lifecycle outcome=${outcomeE}, elapsed=${elapsedE}ms, companion_status ->`, JSON.stringify(statusE));
      console.log("E13: parsed SKILL_RESULT ->", JSON.stringify(resultE));

      check(
        "E13: skill process lifecycle completed within the poll budget (did not time out while still running)",
        outcomeE !== "timeout",
        outcomeE === "timeout" ? `still running after ${SKILL_POLL_BUDGET_MS}ms - companion_status=${JSON.stringify(statusE)}` : `outcome=${outcomeE}`
      );
      check(
        "E13: skill wrote a terminal SKILL_RESULT line to its log before exiting",
        outcomeE === "done",
        outcomeE === "no-result" ? `process exited (lastSkillResult=${JSON.stringify(statusE?.lastSkillResult)}) but no SKILL_RESULT line was found` : `outcome=${outcomeE}`
      );
      check(
        "E13 (Done-when): the skill completed well under its own 30s MINING_TIMEOUT",
        elapsedE < SKILL_WELL_UNDER_MS,
        `elapsed=${elapsedE}ms (budget for 'well under' is ${SKILL_WELL_UNDER_MS}ms)`
      );
      check("E13: SKILL_RESULT reports success:true", resultE?.success === true, resultE === null ? `no SKILL_RESULT to read (outcome=${outcomeE})` : JSON.stringify(resultE));
      check("E13: lastSkillResult.exitCode === 0", statusE?.lastSkillResult?.exitCode === 0, JSON.stringify(statusE?.lastSkillResult));
    });
  } finally {
    console.log("\n--- Cleanup ---");

    try {
      // companion_stop kills any still-running TS skill AND clears Lua queues in one call.
      await callToolRaw(mcp.client, "companion_stop", { companionId: HARVEST_ID });
    } catch (e) {
      console.log("Cleanup companion_stop failed (reporting, not hiding):", e);
    }

    try {
      await clearStaleCompanion(mcp, rcon, HARVEST_ID);
    } catch (e) {
      console.log("Cleanup companion_disappear failed (reporting, not hiding):", e);
    }

    if (plantedOrePositions.length > 0) {
      try {
        const destroyedOre = await destroyOreTiles(rcon, plantedOrePositions);
        console.log("Cleanup: destroyed planted ore tiles ->", JSON.stringify(destroyedOre), `(planted ${plantedOrePositions.length})`);
      } catch (e) {
        console.log("Cleanup ore-tile removal failed (reporting, not hiding):", e);
      }
    }

    await mcp.close();
    await rcon.close();
  }

  process.exit(summary());
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
