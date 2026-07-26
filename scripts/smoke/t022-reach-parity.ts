// Live smoke test for T-022: "companion reach limits are now ALWAYS-ON (player parity)".
//
// Contract under test (mod 0.15.0, factorio-mod/changelog.txt Version 0.15.0):
//   - Reach enforcement, previously opt-in via companion_realistic, is now unconditional for
//     every companion. resource_mine and building_can_place/building_place run
//     u.check_reach() BEFORE touching the world (before even looking for a resource/entity at
//     the target), with the same limits a human player has: resource_reach_distance (~2.7,
//     live-probed) for mining, reach_distance (10) for building.
//   - The opt-in flag itself is gone: no companion_realistic MCP tool, no fac_companion_realistic
//     RCON command, no "realistic" field on companion_list entries.
//   - Two consumers built for the OLD unenforced-reach world had to change to keep working:
//     resource_mine_until (src/skills/mine-until.ts) now walks-to-target-and-retries-once on a
//     "Too far" refusal, with its walk/arrival thresholds tightened from 5/2 to 2.5/1 tiles to
//     stay inside the real 2.7-tile reach; build_smelter_line (src/skills/build-smelter-line.ts)
//     now walks to each furnace position instead of placing a whole line from one standing spot.
//
// Pre-fix baseline this suite is proving the flip from (probed live against the previous
// build): an out-of-reach resource_mine was ACCEPTED ({mining:true,...}) and silently harvested
// nothing; an out-of-reach building_can_place returned {can_place:true}.
//
// Sections, run in this order against companions 31 (A/B/C/E) and 32 (D):
//   A. Mining reach - the card's core Done-when: resource_mine refuses an out-of-reach ore
//      without touching it, and still works on the same ore once in range.
//   B. Building reach - building_can_place refuses out-of-reach, still true in range.
//   C. The flag is gone - MCP tool list, Lua command, companion_list field.
//   D. Consumer regression - resource_mine_until still completes a small mining job that starts
//      out of range (companion 32, kept separate so its ore-count deltas never entangle with A's).
//   E. Consumer regression - build_smelter_line still places a full short line when the start
//      point is far enough that it has to walk there first.
//
// Run directly against a live Factorio game + MCP server - ONLY after the mod's control-stage
// code has been reloaded via a save re-host (main menu -> Host Saved Game; see CLAUDE.md's
// Gotchas - a version bump alone does not reload control.lua):
//   bun run scripts/smoke/t022-reach-parity.ts
import { readFileSync } from "node:fs";
import { connectMCP, connectRCON, callTool, callToolRaw, check, summary, silent } from "./lib";
import { asArray } from "../../src/utils/connection";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Distinct, high companion ids so this suite never collides with t021 (uses 1) or t026 (uses
// 21-24). 32 is kept separate from 31 so section D's before/after ore-count deltas can never be
// polluted by section A mining the same companion's inventory.
const MINING_BUILDING_ID = 31; // sections A, B, C, E
const MINE_UNTIL_ID = 32; // section D only

// t026's two-hop pattern: /silent-command can't see storage.companions, so resolve position via
// the MCP tool first, then find the non-player character near it. 1.5, not t021's 6 - with two
// companions alive, radius 6 can resolve the wrong one.
const ENTITY_LOOKUP_RADIUS = 1.5;

const MINE_FAR_DISTANCE = 25; // > 20 tiles, comfortably beyond resource_reach_distance (~2.7)
const MINE_NEAR_RADIUS = 1.5; // spec target for the in-range control approach
const MINE_POLL_BUDGET_MS = 20000; // in-range native mining of a couple ore is fast
const BUILD_FAR_OFFSET = 30; // tiles, comfortably beyond reach_distance (10)
const BUILD_NEAR_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: 2, dy: 0 },
  { dx: -2, dy: 0 },
  { dx: 0, dy: 2 },
  { dx: 0, dy: -2 },
  { dx: 2, dy: 2 },
  { dx: -2, dy: -2 },
];
const STAGE_CHEST_COUNT = 3; // "a few" per the card's setup note
const SMELTER_FAR_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: 15, dy: 0 },
  { dx: -15, dy: 0 },
  { dx: 0, dy: 15 },
  { dx: 0, dy: -15 },
  { dx: 15, dy: 15 },
  { dx: -15, dy: -15 },
  { dx: 15, dy: -15 },
  { dx: -15, dy: 15 },
  { dx: 20, dy: 0 },
  { dx: 0, dy: 20 },
];
const SMELTER_COUNT = 2; // short line, per the card
// Mirrors build-smelter-line.ts's STANDOFF: for a horizontal line with inputSide "left" the
// skill walks to (furnace.x, furnace.y + 4) rather than onto the furnace tile itself.
const SMELTER_STANDOFF = 4;
const MINE_UNTIL_TARGET = 6; // small, keep it quick
const MINE_UNTIL_FAR_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: 8, dy: 0 },
  { dx: -8, dy: 0 },
  { dx: 0, dy: 8 },
  { dx: 0, dy: -8 },
];
// resource_mine_until has a hard ~30s floor per mining attempt: its waitForMiningComplete polls
// until the Lua harvest queue reports inactive, and that queue does not end on its own (the
// companion keeps re-mining the same ore entity, so `harvested` never leaves zero), so the skill
// always rides out its own 30s MINING_TIMEOUT before stopping the queue and re-checking
// inventory. How many times that 30s floor gets paid (and thus the wall-clock total) varies
// attempt to attempt - a fixed budget of 150000ms passed on two runs and gave a false-red 26/30
// on a third (mining had genuinely worked - ore rose 0 -> 9 - but the skill process hadn't yet
// written its terminal SKILL_RESULT line when the budget ran out). pollUntilSkillDone already
// waits on the actual process lifecycle (companion_status's skill.running flag), not a sleep; the
// fix is a much more generous ceiling so a slow run has real headroom instead of a coin flip.
const SKILL_POLL_BUDGET_MS = 10 * 60 * 1000; // 10 minutes - correctness over suite speed here
const SKILL_POLL_INTERVAL_MS = 1500;

interface MineUntilSkillResult {
  skill: string;
  companionId: number;
  mined: number;
  target: number;
  success: boolean;
}

/** The three lifecycle outcomes pollUntilSkillDone can report, kept distinct on purpose: they
 *  are different diagnoses of a red run and must not collapse into a single null/false reading.
 *   - "timeout": the poll budget ran out while companion_status still reported the skill running.
 *   - "no-result": the skill process exited (exitCode is known) but its log had no SKILL_RESULT
 *     line - a crash before it could write one, or (rarely) a filesystem flush race.
 *   - "done": the skill exited and SKILL_RESULT parsed. success:true/false is a separate question
 *     from whether the artifact exists at all - "done" says nothing about which. */
type SkillPollOutcome = "timeout" | "no-result" | "done";

/** Lua snippet prefix that finds the (single) non-player character near (x, y) and binds it to
 *  __target. Copied per-file convention (t019, t026 each keep their own copy rather than a
 *  shared import) rather than factored out. */
function findEntityNearLua(x: number, y: number, radius = ENTITY_LOOKUP_RADIUS): string {
  return `
    local __player = game.players[1]
    local __target
    for _, e in ipairs(__player.surface.find_entities_filtered{name="character", position={x=${x}, y=${y}}, radius=${radius}}) do
      if e.valid and e ~= __player.character then __target = e; break end
    end
    if not __target then rcon.print(helpers.table_to_json({error = "companion not found"})); return end
  `;
}

/** Runs one independent section, converting an unexpected throw into a failed check instead of
 *  aborting the whole suite. D and E test different consumers on different companions and each
 *  must still run when the other blows up - E's first live run threw on an MCP request timeout
 *  and D silently never executed, so the run reported only A/B/C with no indication D was
 *  missing. Deliberately NOT used for the A/B/C setup path: those share companion 31's state
 *  and a failure there really does invalidate everything downstream. */
async function runSection(label: string, banner: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  try {
    await body();
  } catch (e) {
    check(`${label}: section ran to completion without an unexpected throw`, false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
  }
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

/** Polls companion_status until the skill's process lifecycle has actually ended (server-side
 *  skill.running flips false and an exit code has been recorded), not until a wall-clock budget
 *  runs out - the budget here is only an outer safety bound, generous enough that a slow mining
 *  run has real headroom (see SKILL_POLL_BUDGET_MS's comment for why a tighter one flaked).
 *  Returns one of three outcomes (see SkillPollOutcome) so a red run tells the reader WHICH of
 *  "still running", "exited with nothing written", or "exited and parsed" happened, instead of
 *  every case reading as an identical `null`. */
async function pollUntilSkillDone(mcp: { client: any }, companionId: number): Promise<{ status: any; result: MineUntilSkillResult | null; outcome: SkillPollOutcome }> {
  const start = Date.now();
  let status: any = null;
  while (Date.now() - start < SKILL_POLL_BUDGET_MS) {
    status = await callTool(mcp.client, "companion_status", { companionId });
    if (status.skill?.running !== true && status.lastSkillResult) {
      const result = parseSkillResultLog(status.lastSkillResult.logPath);
      return { status, result, outcome: result !== null ? "done" : "no-result" };
    }
    console.log("  ...skill still running, elapsed", Date.now() - start, "ms");
    await sleep(SKILL_POLL_INTERVAL_MS);
  }
  return { status, result: null, outcome: "timeout" };
}

/** Finds a non-colliding character-sized spot near one of `ref + offset`, trying each offset in
 *  order. Used to manufacture a controlled out-of-reach (section A/D) or in-reach (section A)
 *  teleport target - teleporting/spawning is sanctioned in harness code only (owner's explicit
 *  scoping), never in the mod's own gameplay behaviour. */
async function findNonCollidingSpot(
  rcon: { send: (cmd: string) => Promise<string> },
  ref: { x: number; y: number },
  offsets: Array<{ dx: number; dy: number }>,
  searchRadius: number
): Promise<{ found: boolean; x?: number; y?: number }> {
  const offsetsLua = offsets.map((o) => `{dx=${o.dx}, dy=${o.dy}}`).join(", ");
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local ref = {x = ${ref.x}, y = ${ref.y}}
      local candidates = {${offsetsLua}}
      local chosen_x, chosen_y
      for _, c in ipairs(candidates) do
        local pos = surface.find_non_colliding_position("character", {x=ref.x + c.dx, y=ref.y + c.dy}, ${searchRadius}, 0.5)
        if pos then chosen_x, chosen_y = pos.x, pos.y; break end
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

/** Teleports the companion currently near (curX, curY) to the already-validated (destX, destY).
 *  Test-harness-only - the mod's own gameplay code never teleports a companion. */
async function teleportCompanionTo(
  rcon: { send: (cmd: string) => Promise<string> },
  curX: number,
  curY: number,
  destX: number,
  destY: number
): Promise<{ teleported: boolean }> {
  const raw = await silent(
    rcon,
    findEntityNearLua(curX, curY) +
      `
      local teleported = __target.teleport({x=${destX}, y=${destY}})
      rcon.print(helpers.table_to_json({teleported = teleported}))
    `
  );
  return JSON.parse(raw);
}

/** Reads a companion's main-inventory count for one item, by side channel (bypasses the MCP
 *  tool layer entirely, for ground truth independent of anything resource_mine/companion_status
 *  itself claims). */
async function readInventoryCount(
  rcon: { send: (cmd: string) => Promise<string> },
  x: number,
  y: number,
  itemName: string
): Promise<number> {
  const raw = await silent(
    rcon,
    findEntityNearLua(x, y) +
      `
      local count = __target.get_inventory(defines.inventory.character_main).get_item_count("${itemName}")
      rcon.print(helpers.table_to_json({count = count}))
    `
  );
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`readInventoryCount(${x}, ${y}, ${itemName}) could not find the companion: ${raw}`);
  return parsed.count;
}

interface BuildCandidate {
  anchorX: number;
  anchorY: number;
  positions: Array<{ name: string; x: number; y: number }>;
}

/** Finds the first candidate anchor whose ENTIRE position set is buildable, via a direct
 *  side-channel surface.can_place_entity check - bypassing the companion's own reach entirely,
 *  so a chosen spot's buildability is real ground truth, not a lucky pass through the very
 *  reach gate this suite is testing. Used for B2's near control (one position) and E's smelter
 *  start (four positions: two furnaces + two feeding inserters). */
async function findBuildableSpot(rcon: { send: (cmd: string) => Promise<string> }, candidates: BuildCandidate[]): Promise<{ found: boolean; x?: number; y?: number }> {
  const candidatesLua = candidates
    .map((c) => {
      const posLua = c.positions.map((p) => `{name="${p.name}", x=${p.x}, y=${p.y}}`).join(", ");
      return `{ax=${c.anchorX}, ay=${c.anchorY}, positions={${posLua}}}`;
    })
    .join(", ");
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local force = game.players[1].force
      local candidates = {${candidatesLua}}
      local chosen
      for _, c in ipairs(candidates) do
        local ok = true
        for _, p in ipairs(c.positions) do
          if not surface.can_place_entity{name=p.name, position={x=p.x, y=p.y}, force=force} then ok = false; break end
        end
        if ok then chosen = {x = c.ax, y = c.ay}; break end
      end
      if chosen then
        rcon.print(helpers.table_to_json({found = true, x = chosen.x, y = chosen.y}))
      else
        rcon.print(helpers.table_to_json({found = false}))
      end
    `
  );
  return JSON.parse(raw);
}

/** Destroys any item-on-ground entities within a small radius of (x, y) - used right after a
 *  companion_disappear spills its inventory/equipment (companion.lua's spill_inventory /
 *  spill_equipment). That residue belongs to a companion this harness is removing, not to the
 *  player, so it is destroyed outright rather than reinserted (same convention as t026). */
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

/** Removes any companion at `id` that is still alive - left over from a previous run of this
 *  suite, or (in teardown) this run's own. fac_companion_disappear clears storage.companions[id]
 *  unconditionally and spills EVERYTHING the companion was carrying (main inventory, gun, ammo)
 *  to the ground, so a subsequent companion_spawn takes the fresh-spawn branch rather than the
 *  {status:"exists"} no-op that skips spawn-time work entirely (t026's root-cause fix). Every
 *  item this suite stages goes into the COMPANION's own inventory (never the player's), so this
 *  spill-then-destroy is also this suite's full cleanup for staged items - there is no separate
 *  "remove exactly what was staged" step needed against the player's inventory. */
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

async function main() {
  const mcp = await connectMCP();
  const rcon = await connectRCON();

  // Tracked at top scope so a throw mid-section still lets the top-level cleanup tear these
  // down, mirroring t026's check5SpawnedIds/check6SpawnedIds pattern. A holder object rather
  // than a bare `let`: section E now assigns it from inside a runSection callback, and
  // TypeScript does not track writes across a function boundary, so a plain local would be
  // narrowed to `null` in the cleanup block below.
  const built: { smelterAnchor: { x: number; y: number } | null } = { smelterAnchor: null };

  try {
    // -----------------------------------------------------------
    // Setup: companion 31 for sections A, B, C, E
    // -----------------------------------------------------------
    console.log("\n=== Setup: companion 31 (sections A, B, C, E) ===");
    await clearStaleCompanion(mcp, rcon, MINING_BUILDING_ID);
    const spawnA = await callTool(mcp.client, "companion_spawn", { companionId: MINING_BUILDING_ID });
    console.log("companion_spawn (31) ->", JSON.stringify(spawnA));
    check("Setup: companion 31 spawned genuinely fresh (spawned:true, not status:'exists')", spawnA.spawned === true, JSON.stringify(spawnA));
    if (spawnA.spawned !== true) {
      throw new Error(`Companion ${MINING_BUILDING_ID} did not spawn fresh (${JSON.stringify(spawnA)}) - aborting, every downstream check would be meaningless.`);
    }

    // -----------------------------------------------------------
    // Section A: mining reach
    // -----------------------------------------------------------
    console.log("\n=== A1/A2: mining reach refuses an out-of-reach ore, and mines nothing ===");
    const companionPosA0 = await callTool(mcp.client, "companion_position", { companionId: MINING_BUILDING_ID });
    const nearestOre = await callTool(mcp.client, "resource_nearest", { companionId: MINING_BUILDING_ID, resourceType: "iron-ore" });
    console.log("resource_nearest (iron-ore) ->", JSON.stringify(nearestOre));
    if (nearestOre?.error || !nearestOre?.position) {
      throw new Error(`No iron-ore found near companion ${MINING_BUILDING_ID} (resource_nearest -> ${JSON.stringify(nearestOre)}) - section A cannot run without a real resource target.`);
    }
    const orePos: { x: number; y: number } = nearestOre.position;

    const distToOre0 = dist(companionPosA0.position, orePos);
    if (distToOre0 <= 20) {
      const farSpot = await findNonCollidingSpot(rcon, orePos, [
        { dx: MINE_FAR_DISTANCE, dy: 0 },
        { dx: -MINE_FAR_DISTANCE, dy: 0 },
        { dx: 0, dy: MINE_FAR_DISTANCE },
        { dx: 0, dy: -MINE_FAR_DISTANCE },
        { dx: MINE_FAR_DISTANCE, dy: MINE_FAR_DISTANCE },
        { dx: -MINE_FAR_DISTANCE, dy: -MINE_FAR_DISTANCE },
      ], 10);
      console.log("A1 setup: far spot ->", JSON.stringify(farSpot));
      check("A1 setup: found a non-colliding spot >20 tiles from the ore", farSpot.found === true, JSON.stringify(farSpot));
      if (farSpot.found) {
        const tp = await teleportCompanionTo(rcon, companionPosA0.position.x, companionPosA0.position.y, farSpot.x!, farSpot.y!);
        check("A1 setup: companion teleported away from the ore", tp.teleported === true, JSON.stringify(tp));
      }
    }

    const companionPosA1 = await callTool(mcp.client, "companion_position", { companionId: MINING_BUILDING_ID });
    const distToOre1 = dist(companionPosA1.position, orePos);
    check("A1 setup: companion is manufactured >20 tiles from the targeted ore", distToOre1 > 20, `distance=${distToOre1.toFixed(2)}`);

    const oreCountBeforeA = await readInventoryCount(rcon, companionPosA1.position.x, companionPosA1.position.y, "iron-ore");

    const mineFarRes = await callTool(mcp.client, "resource_mine", {
      companionId: MINING_BUILDING_ID,
      x: orePos.x,
      y: orePos.y,
      count: 5,
      resourceName: "iron-ore",
    });
    console.log("resource_mine (out of reach) ->", JSON.stringify(mineFarRes));
    check(
      "A1 (Done-when): out-of-reach resource_mine returns {error:'Too far'}, decisively NOT {mining:true} (the pre-fix baseline accepted this and then silently harvested nothing)",
      mineFarRes?.error === "Too far" && mineFarRes?.mining !== true,
      JSON.stringify(mineFarRes)
    );

    const oreCountAfterA = await readInventoryCount(rcon, companionPosA1.position.x, companionPosA1.position.y, "iron-ore");
    check(
      "A2: independent ground truth - side-channel ore count is unchanged after the refusal (nothing was silently harvested)",
      oreCountAfterA === oreCountBeforeA,
      JSON.stringify({ before: oreCountBeforeA, after: oreCountAfterA })
    );

    console.log("\n=== A3: in-range control - resource_mine still works within reach ===");
    const nearSpot = await findNonCollidingSpot(rcon, orePos, [{ dx: 0, dy: 0 }], MINE_NEAR_RADIUS);
    console.log("A3 setup: near spot ->", JSON.stringify(nearSpot));
    check("A3 setup: found a non-colliding spot within ~1.5 tiles of the ore", nearSpot.found === true, JSON.stringify(nearSpot));
    if (nearSpot.found) {
      const tp2 = await teleportCompanionTo(rcon, companionPosA1.position.x, companionPosA1.position.y, nearSpot.x!, nearSpot.y!);
      check("A3 setup: companion teleported near the ore", tp2.teleported === true, JSON.stringify(tp2));
    }

    const companionPosA3 = await callTool(mcp.client, "companion_position", { companionId: MINING_BUILDING_ID });
    const oreCountBeforeA3 = await readInventoryCount(rcon, companionPosA3.position.x, companionPosA3.position.y, "iron-ore");

    const mineNearRes = await callTool(mcp.client, "resource_mine", {
      companionId: MINING_BUILDING_ID,
      x: orePos.x,
      y: orePos.y,
      count: 3,
      resourceName: "iron-ore",
    });
    console.log("resource_mine (in reach) ->", JSON.stringify(mineNearRes));
    check("A3: in-reach resource_mine is accepted (mining:true) - reach enforcement didn't just break mining outright", mineNearRes?.mining === true, JSON.stringify(mineNearRes));

    // Poll to completion - check() calls stay OUT of this loop, only the final outcome is asserted.
    let mineStatus: any = null;
    const minePollStart = Date.now();
    while (Date.now() - minePollStart < MINE_POLL_BUDGET_MS) {
      mineStatus = await callTool(mcp.client, "resource_mine_status", { companionId: MINING_BUILDING_ID });
      if (mineStatus?.status?.active !== true) break;
      await sleep(500);
    }
    console.log("resource_mine_status (final, A3) ->", JSON.stringify(mineStatus));

    // A3's harvest queue does NOT reliably end on its own: the companion keeps mining the same
    // ore entity, so `harvested` never ticks up off zero and the queue stays active forever.
    // Leaving it running is not cosmetic - an active harvest queue PINS the companion in place
    // (mining_state overrides walking_state), so every later section that needs this companion
    // to walk silently hangs. That is exactly how section E first failed: build_smelter_line
    // burned its whole walk budget going nowhere and blew the MCP client's 60s request timeout.
    const mineStopped = await callTool(mcp.client, "resource_mine_stop", { companionId: MINING_BUILDING_ID });
    console.log("A3 teardown: resource_mine_stop ->", JSON.stringify(mineStopped));
    const mineStatusAfterStop = await callTool(mcp.client, "resource_mine_status", { companionId: MINING_BUILDING_ID });
    check(
      "A3 teardown: the harvest queue is stopped before any later section reuses companion 31 - an active one pins it in place and every subsequent walk hangs",
      mineStatusAfterStop?.status?.active !== true,
      JSON.stringify(mineStatusAfterStop)
    );

    const oreCountAfterA3 = await readInventoryCount(rcon, companionPosA3.position.x, companionPosA3.position.y, "iron-ore");
    check(
      "A3 (load-bearing): in-range mining actually raised the companion's ore count by side channel - we didn't just break mining",
      oreCountAfterA3 > oreCountBeforeA3,
      JSON.stringify({ before: oreCountBeforeA3, after: oreCountAfterA3 })
    );

    // -----------------------------------------------------------
    // Section B: building reach
    // -----------------------------------------------------------
    console.log("\n=== B. Building reach ===");
    const companionPosB = await callTool(mcp.client, "companion_position", { companionId: MINING_BUILDING_ID });
    const bx = companionPosB.position.x;
    const by = companionPosB.position.y;

    // building_can_place short-circuits to {can_place:false, reason:"Not in inventory"} before
    // it ever reaches the reach/terrain checks if the companion has no such item - stage a few
    // wooden chests first so a reach assertion below isn't vacuous.
    const chestStageRaw = await silent(
      rcon,
      findEntityNearLua(bx, by) +
        `
        local inv = __target.get_inventory(defines.inventory.character_main)
        local inserted = inv.insert{name="wooden-chest", count=${STAGE_CHEST_COUNT}}
        rcon.print(helpers.table_to_json({inserted = inserted}))
      `
    );
    const chestStage = JSON.parse(chestStageRaw);
    console.log("B setup: staged wooden-chest into companion inventory ->", chestStageRaw);
    check("B setup: staged at least one wooden-chest into the companion's inventory", chestStage.inserted > 0, chestStageRaw);

    const farBuildRes = await callTool(mcp.client, "building_can_place", {
      companionId: MINING_BUILDING_ID,
      entityName: "wooden-chest",
      x: bx + BUILD_FAR_OFFSET,
      y: by,
    });
    console.log("building_can_place (far) ->", JSON.stringify(farBuildRes));
    check(
      "B1 (Done-when): out-of-reach building_can_place returns {error:'Too far'}, decisively NOT {can_place:true} (the pre-fix baseline)",
      farBuildRes?.error === "Too far" && farBuildRes?.can_place !== true,
      JSON.stringify(farBuildRes)
    );

    const nearBuildCandidates: BuildCandidate[] = BUILD_NEAR_OFFSETS.map((o) => ({
      anchorX: bx + o.dx,
      anchorY: by + o.dy,
      positions: [{ name: "wooden-chest", x: bx + o.dx, y: by + o.dy }],
    }));
    const nearBuildSpot = await findBuildableSpot(rcon, nearBuildCandidates);
    console.log("B2 setup: near buildable spot ->", JSON.stringify(nearBuildSpot));
    check("B2 setup: found real buildable ground ~2 tiles from the companion (verified by direct side-channel can_place_entity)", nearBuildSpot.found === true, JSON.stringify(nearBuildSpot));

    if (nearBuildSpot.found) {
      const nearBuildRes = await callTool(mcp.client, "building_can_place", {
        companionId: MINING_BUILDING_ID,
        entityName: "wooden-chest",
        x: nearBuildSpot.x,
        y: nearBuildSpot.y,
      });
      console.log("building_can_place (near control) ->", JSON.stringify(nearBuildRes));
      check("B2: in-reach building_can_place still returns {can_place:true} - reach enforcement didn't just break placement checks", nearBuildRes?.can_place === true, JSON.stringify(nearBuildRes));
    }

    // -----------------------------------------------------------
    // Section C: the flag is gone
    // -----------------------------------------------------------
    console.log("\n=== C. companion_realistic is gone entirely ===");
    const toolList = await mcp.client.listTools();
    const toolNames = asArray<{ name: string }>(toolList?.tools).map((t) => t.name);
    check("C1: MCP tool list no longer contains companion_realistic", !toolNames.includes("companion_realistic"), JSON.stringify(toolNames));

    let c2Response: string | null = null;
    let c2Threw: string | null = null;
    try {
      c2Response = await rcon.send(`/fac_companion_realistic ${MINING_BUILDING_ID} true`);
      console.log("Raw response to /fac_companion_realistic ->", JSON.stringify(c2Response));
    } catch (e) {
      c2Threw = e instanceof Error ? e.message : String(e);
      console.log("connectRCON().send threw for /fac_companion_realistic ->", c2Threw);
    }
    // Every real fac_* command replies through u.json_response, which always emits a JSON
    // object. An unknown command never runs mod code at all - Factorio's own console rejects
    // the unregistered command name before dispatch. Whichever channel it surfaces on (a thrown
    // error from connectRCON().send()'s success:false path, or an ordinary string reply), the
    // decisive, verifiable-without-guessing-the-exact-wording assertion is the same: it is not
    // parseable JSON shaped like a mod response.
    const c2Text = c2Threw ?? c2Response ?? "";
    let c2IsJson = false;
    try {
      JSON.parse(c2Text);
      c2IsJson = true;
    } catch {
      /* expected for an unknown command */
    }
    check(
      "C2: /fac_companion_realistic is no longer a registered command (response is not a JSON mod reply)",
      c2Text.length > 0 && !c2IsJson,
      JSON.stringify({ response: c2Response, threw: c2Threw })
    );

    const listRes = await callTool(mcp.client, "companion_list", {});
    const companions = asArray<Record<string, unknown>>(listRes?.companions);
    console.log("companion_list ->", JSON.stringify(listRes));
    check(
      "C3: companion_list has at least one entry to check (companion 31 alive)",
      companions.length > 0,
      JSON.stringify(listRes)
    );
    const anyHasRealistic = companions.some((c) => Object.prototype.hasOwnProperty.call(c, "realistic"));
    check("C3: no companion_list entry carries a 'realistic' field", !anyHasRealistic, JSON.stringify(companions));

    // -----------------------------------------------------------
    // Section E: build_smelter_line now walks (companion 31)
    // -----------------------------------------------------------
    // D and E are independent regression checks on different consumers and different
    // companions, so neither may be allowed to abort the other - an E throw (its first live
    // run blew the MCP client's 60s request timeout) previously meant D never ran at all and
    // the suite reported only A/B/C. Each is sealed in runSection, which converts an
    // unexpected throw into a failed check and lets the rest of the suite continue.
    await runSection("E", "Consumer regression - build_smelter_line walks to a far start point", async () => {
    const companionPosE = await callTool(mcp.client, "companion_position", { companionId: MINING_BUILDING_ID });
    const ex = companionPosE.position.x;
    const ey = companionPosE.position.y;

    // Stage exactly what a 2-furnace horizontal/left line needs: 2 stone-furnace + 2 inserter.
    const smelterStageRaw = await silent(
      rcon,
      findEntityNearLua(ex, ey) +
        `
        local inv = __target.get_inventory(defines.inventory.character_main)
        local furnaces_inserted = inv.insert{name="stone-furnace", count=${SMELTER_COUNT}}
        local inserters_inserted = inv.insert{name="inserter", count=${SMELTER_COUNT}}
        rcon.print(helpers.table_to_json({furnaces_inserted = furnaces_inserted, inserters_inserted = inserters_inserted}))
      `
    );
    const smelterStage = JSON.parse(smelterStageRaw);
    console.log("E setup: staged furnace/inserter into companion inventory ->", smelterStageRaw);
    check(
      `E setup: staged ${SMELTER_COUNT}x stone-furnace and ${SMELTER_COUNT}x inserter into the companion's inventory`,
      smelterStage.furnaces_inserted === SMELTER_COUNT && smelterStage.inserters_inserted === SMELTER_COUNT,
      smelterStageRaw
    );

    // Anchor candidates far enough that build_smelter_line's default reach_distance-limited
    // start (10) would refuse from the companion's current standing spot - it must walk there.
    // Layout matches build-smelter-line.ts's defaults (direction:"horizontal", inputSide:"left",
    // spacing 2, inserter at furnace.x - 1). The trailing "character" position is that skill's
    // STANDOFF spot (perpendicular to the line, opposite the inserters): the skill walks THERE,
    // not onto the line, so a candidate whose standing spot is water/cliff would fail the walk
    // for reasons that have nothing to do with reach parity.
    const smelterCandidates: BuildCandidate[] = SMELTER_FAR_OFFSETS.map((o) => {
      const sx = ex + o.dx;
      const sy = ey + o.dy;
      return {
        anchorX: sx,
        anchorY: sy,
        positions: [
          { name: "stone-furnace", x: sx, y: sy },
          { name: "inserter", x: sx - 1, y: sy },
          { name: "stone-furnace", x: sx + 2, y: sy },
          { name: "inserter", x: sx + 1, y: sy },
          { name: "character", x: sx, y: sy + SMELTER_STANDOFF },
        ],
      };
    });
    const smelterSpot = await findBuildableSpot(rcon, smelterCandidates);
    console.log("E setup: smelter start spot ->", JSON.stringify(smelterSpot));
    check("E setup: found a buildable start point far enough to require walking (verified by direct side-channel can_place_entity)", smelterSpot.found === true, JSON.stringify(smelterSpot));

    if (smelterSpot.found) {
      const smelterAnchor = { x: smelterSpot.x!, y: smelterSpot.y! };
      built.smelterAnchor = smelterAnchor;
      const distToStart = dist(companionPosE.position, smelterAnchor);
      check("E setup: start point is manufactured beyond build reach (10) from the companion's current spot", distToStart > 10, `distance=${distToStart.toFixed(2)}`);

      const smelterRes = await callTool(mcp.client, "build_smelter_line", {
        companionId: MINING_BUILDING_ID,
        x: smelterAnchor.x,
        y: smelterAnchor.y,
        count: SMELTER_COUNT,
        furnaceType: "stone-furnace",
        direction: "horizontal",
        inputSide: "left",
      });
      console.log("build_smelter_line ->", JSON.stringify(smelterRes));
      check(
        "E (Done-when): build_smelter_line reports success and placed the full requested count despite having to walk there first",
        smelterRes?.success === true && smelterRes?.data?.furnacesPlaced === SMELTER_COUNT,
        JSON.stringify(smelterRes)
      );

      const groundFurnacesRaw = await silent(
        rcon,
        `
          local surface = game.players[1].surface
          local found = surface.find_entities_filtered{name="stone-furnace", position={x=${smelterAnchor.x}, y=${smelterAnchor.y}}, radius=6}
          rcon.print(helpers.table_to_json({count = #found}))
        `
      );
      console.log("E DECISIVE: furnaces on the ground by side channel ->", groundFurnacesRaw);
      check("E DECISIVE: the requested count of furnaces genuinely exists on the ground, by side channel", JSON.parse(groundFurnacesRaw).count === SMELTER_COUNT, groundFurnacesRaw);
    }
    });

    // -----------------------------------------------------------
    // Section D: resource_mine_until still works (companion 32)
    // -----------------------------------------------------------
    await runSection("D", "Consumer regression - resource_mine_until still completes under always-on reach", async () => {
    await clearStaleCompanion(mcp, rcon, MINE_UNTIL_ID);
    const spawnD = await callTool(mcp.client, "companion_spawn", { companionId: MINE_UNTIL_ID });
    console.log("companion_spawn (32) ->", JSON.stringify(spawnD));
    check("D setup: companion 32 spawned genuinely fresh (spawned:true, not status:'exists')", spawnD.spawned === true, JSON.stringify(spawnD));
    if (spawnD.spawned !== true) {
      throw new Error(`Companion ${MINE_UNTIL_ID} did not spawn fresh (${JSON.stringify(spawnD)}) - aborting section D, every downstream check would be meaningless.`);
    }

    const companionPosD0 = await callTool(mcp.client, "companion_position", { companionId: MINE_UNTIL_ID });
    const nearestOreD = await callTool(mcp.client, "resource_nearest", { companionId: MINE_UNTIL_ID, resourceType: "iron-ore" });
    console.log("resource_nearest (iron-ore, companion 32) ->", JSON.stringify(nearestOreD));
    if (nearestOreD?.error || !nearestOreD?.position) {
      throw new Error(`No iron-ore found near companion ${MINE_UNTIL_ID} (resource_nearest -> ${JSON.stringify(nearestOreD)}) - section D cannot run without a real resource target.`);
    }

    // Always place the companion at a CONTROLLED start distance, in both directions - the old
    // "only move it if it is already too close" form left the live map deciding how far the
    // skill has to walk, and on this save the nearest iron-ore is 228 tiles from spawn. That
    // walk alone ate most of the poll budget below and the section timed out having mined
    // fine. Same controlled-arena convention the combat suites use (see CLAUDE.md).
    console.log("D setup: distance from spawn to the nearest ore was", dist(companionPosD0.position, nearestOreD.position).toFixed(1), "- relocating to a controlled start distance");
    const farSpotD = await findNonCollidingSpot(rcon, nearestOreD.position, MINE_UNTIL_FAR_OFFSETS, 5);
    console.log("D setup: far spot ->", JSON.stringify(farSpotD));
    check("D setup: found a spot ~8 tiles from the ore to start the companion out of range", farSpotD.found === true, JSON.stringify(farSpotD));
    if (farSpotD.found) {
      const tpD = await teleportCompanionTo(rcon, companionPosD0.position.x, companionPosD0.position.y, farSpotD.x!, farSpotD.y!);
      check("D setup: companion 32 teleported to the controlled start spot", tpD.teleported === true, JSON.stringify(tpD));
    }

    const companionPosD1 = await callTool(mcp.client, "companion_position", { companionId: MINE_UNTIL_ID });
    const distToOreD1 = dist(companionPosD1.position, nearestOreD.position);
    check(
      "D setup: the companion genuinely starts beyond resource reach (~2.7), so the skill has to walk before it can mine - otherwise this section proves nothing about reach parity",
      distToOreD1 > 3,
      `distance=${distToOreD1.toFixed(2)}`
    );
    const oreCountBeforeD = await readInventoryCount(rcon, companionPosD1.position.x, companionPosD1.position.y, "iron-ore");

    const startD = await callToolRaw(mcp.client, "resource_mine_until", { companionId: MINE_UNTIL_ID, resource: "iron", amount: MINE_UNTIL_TARGET });
    console.log("resource_mine_until (start) ->", startD);

    const { status: mineUntilStatus, result: mineUntilResult, outcome: mineUntilOutcome } = await pollUntilSkillDone(mcp, MINE_UNTIL_ID);
    console.log(`companion_status after resource_mine_until (outcome=${mineUntilOutcome}) ->`, JSON.stringify(mineUntilStatus));
    console.log("Parsed SKILL_RESULT (D) ->", JSON.stringify(mineUntilResult));

    // The three lifecycle outcomes are different diagnoses and must read differently in a red
    // run - collapsing them all into "SKILL_RESULT is null" is exactly the bug this rework fixes
    // (a genuinely-working mining run, ore 0 -> 9, reported four identical `null` failures because
    // the fixed poll budget expired before the process had written its terminal line).
    check(
      "D: skill process lifecycle completed within the poll budget (did not time out while still running)",
      mineUntilOutcome !== "timeout",
      mineUntilOutcome === "timeout" ? `still running after ${SKILL_POLL_BUDGET_MS}ms poll budget - companion_status=${JSON.stringify(mineUntilStatus)}` : `outcome=${mineUntilOutcome}`
    );
    check(
      "D: skill process wrote a terminal SKILL_RESULT line to its log before exiting",
      mineUntilOutcome === "done",
      mineUntilOutcome === "no-result"
        ? `process exited (lastSkillResult=${JSON.stringify(mineUntilStatus?.lastSkillResult)}) but no SKILL_RESULT line was found in its log`
        : mineUntilOutcome === "timeout"
        ? "not applicable - process never exited within the poll budget, see the previous check"
        : "SKILL_RESULT parsed successfully"
    );
    check(
      "D: SKILL_RESULT reports success:true",
      mineUntilResult?.success === true,
      mineUntilResult === null ? `no SKILL_RESULT to read (outcome=${mineUntilOutcome})` : JSON.stringify(mineUntilResult)
    );
    check(
      "D: SKILL_RESULT reports a nonzero harvested amount",
      typeof mineUntilResult?.mined === "number" && mineUntilResult.mined > 0,
      mineUntilResult === null ? `no SKILL_RESULT to read (outcome=${mineUntilOutcome})` : JSON.stringify(mineUntilResult)
    );
    check("D: lastSkillResult.exitCode === 0", mineUntilStatus?.lastSkillResult?.exitCode === 0, JSON.stringify(mineUntilStatus?.lastSkillResult));

    // Independent of all of the above: this is the load-bearing evidence that mining actually
    // happened, read by side channel from the companion's real inventory rather than from
    // anything the skill process itself reported. It must stand or fall on the ore delta alone -
    // a missing/unparseable SKILL_RESULT (checked above) is a reporting defect, not proof mining
    // didn't work, and must never drag this check down with it. Guarded (not a bare await-and-
    // index) because section D runs on the real live map rather than a cleared arena: if the
    // companion was killed/removed mid-run (observed live - biters near a far-out ore patch),
    // companion_position comes back {error:...} with no .position, and an unguarded .position.x
    // would throw here - turning one real, nameable failure into an opaque stack trace instead of
    // a diagnosis, and (worse) skipping these two checks entirely, which would make the total
    // check count depend on which way the run failed.
    let companionPosD2: any = null;
    let oreCountAfterD: number | null = null;
    try {
      companionPosD2 = await callTool(mcp.client, "companion_position", { companionId: MINE_UNTIL_ID });
      if (companionPosD2?.position) {
        oreCountAfterD = await readInventoryCount(rcon, companionPosD2.position.x, companionPosD2.position.y, "iron-ore");
      }
    } catch (e) {
      console.log(`D: could not read companion ${MINE_UNTIL_ID}'s post-run position/inventory:`, e instanceof Error ? e.message : String(e));
    }
    const minedDeltaD = oreCountAfterD !== null ? oreCountAfterD - oreCountBeforeD : null;
    check(
      "D (independent verification): side-channel ore count rose - mining genuinely happened, regardless of whether SKILL_RESULT was available",
      minedDeltaD !== null && minedDeltaD > 0,
      minedDeltaD !== null
        ? JSON.stringify({ before: oreCountBeforeD, after: oreCountAfterD, delta: minedDeltaD, reportedMined: mineUntilResult?.mined ?? null })
        : `companion ${MINE_UNTIL_ID} could not be found after the skill ended (companion_position -> ${JSON.stringify(companionPosD2)}) - cannot read its post-run inventory, possibly died/was removed mid-run`
    );
    check(
      "D (independent verification, cross-check): when SKILL_RESULT was available, its reported harvest doesn't exceed the real ore delta (vacuously true otherwise)",
      minedDeltaD === null || mineUntilResult === null || minedDeltaD >= mineUntilResult.mined,
      minedDeltaD !== null
        ? JSON.stringify({ before: oreCountBeforeD, after: oreCountAfterD, delta: minedDeltaD, reportedMined: mineUntilResult?.mined ?? null })
        : "not applicable - post-run ore count unavailable, see the previous check"
    );
    });
  } finally {
    console.log("\n--- Cleanup ---");

    for (const id of [MINING_BUILDING_ID, MINE_UNTIL_ID]) {
      try {
        await callToolRaw(mcp.client, "companion_stop", { companionId: id });
      } catch (e) {
        console.log(`Cleanup companion_stop(${id}) failed (reporting, not hiding):`, e);
      }
    }

    // Disappearing spills EVERYTHING each companion is carrying (main inventory incl. any
    // staged-but-unused chests/furnaces/inserters/mined ore, plus gun/ammo if any) to the
    // ground, and destroys that residue - see clearStaleCompanion's doc comment for why this is
    // also this suite's full "remove exactly what was staged" step.
    for (const id of [MINING_BUILDING_ID, MINE_UNTIL_ID]) {
      try {
        await clearStaleCompanion(mcp, rcon, id);
      } catch (e) {
        console.log(`Cleanup companion_disappear(${id}) failed (reporting, not hiding):`, e);
      }
    }

    const smelterAnchor = built.smelterAnchor;
    if (smelterAnchor) {
      try {
        const destroyRaw = await silent(
          rcon,
          `
            local surface = game.players[1].surface
            local destroyed = 0
            for _, e in ipairs(surface.find_entities_filtered{name={"stone-furnace", "inserter"}, position={x=${smelterAnchor.x}, y=${smelterAnchor.y}}, radius=6}) do
              e.destroy(); destroyed = destroyed + 1
            end
            rcon.print(helpers.table_to_json({destroyed = destroyed}))
          `
        );
        console.log("Cleanup: destroyed placed smelter-line entities ->", destroyRaw);
      } catch (e) {
        console.log("Cleanup smelter-line entity removal failed (reporting, not hiding):", e);
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
