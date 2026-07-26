// Live smoke test for T-013: "the last unverified checklist item from the four-way code review"
// (T-012). T-012's review flagged eight items; seven were already covered by other live suites
// or fixed inline. This suite is the live verification pass for the five that were never actually
// run against a live game: chat_say payload integrity (item 1), resource_mine_until accounting
// with a MIXED inventory (item 2), companion_disappear's spill order (item 3), a companion killed
// mid-skill surfacing a real exit code (item 7), and a forced Lua error still round-tripping as
// parseable JSON (item 8).
//
// Contract under test, per item:
//   1. chat.lua:36 (fac_chat_say) echoes back `said` exactly as it was printed - the only mod-side
//      observable, since /silent-command cannot read chat history and there is no other record of
//      what was said. This proves the string survives JS templating (buildRCONCommand's regex
//      replacer, which is immune to $&/$$ because the replacement comes from a FUNCTION callback,
//      not a string), the RCON frame, Factorio's own command-line parsing, and the Lua
//      "^(%S+)%s+(.+)$" pattern - all without alteration. One real, documented deviation:
//      buildRCONCommand collapses whitespace runs and trims the WHOLE composed command
//      (`cmd.replace(/\s+/g, " ").trim()`), so multi-space/leading/trailing whitespace inside a
//      message sent through the MCP tool does NOT survive - only through raw RCON does it.
//   2. mine-until.ts's top-of-loop check ("if I already have >= amount, stop") is a genuine
//      short-circuit, but the per-attempt mining target passed down to the Lua queue
//      (`Math.min(targetAmount - totalMined, 50)`) is computed from `totalMined` - an
//      accumulator that starts at 0 for this skill invocation - NOT from the companion's
//      pre-existing inventory count. So a pre-existing PARTIAL stack of the target item is not
//      subtracted out of what gets mined; only a stack already AT OR ABOVE the target trips the
//      short-circuit. The genuinely fixed part (queues.lua's tick_harvest_queues, T-031) is that
//      `harvested` is a real inventory DELTA measured from a snapshot taken at queue start, so it
//      correctly excludes the pre-existing stack no matter what target value was used - a
//      pre-existing non-target item (coal) sitting alongside it must also be left untouched and
//      uncounted. This suite measures deltas independently rather than hard-coding an expected
//      total, and reports what it finds rather than assuming a specific reading of "amount".
//   3. companion.lua:52-73 (fac_companion_disappear) spills character_main, then guns, then ammo,
//      onto the ground via spill_item_stack, before destroying the entity - so the reported
//      `dropped` list must match the pre-disappear inventory exactly, and the items must actually
//      land on the ground (not merely be claimed).
//   7. server.ts's AUTO_STOP_TOOLS does NOT include companion_disappear, so stopCompanionSkill -
//      and its exitCode:null "killed, not self-terminated" write - never runs for a disappear.
//      A companion killed mid-skill instead has to have its own background process notice (every
//      RCON call it makes now gets {error:"Companion not found"} back) and exit on its own, which
//      is what should produce a real, non-null exitCode and a terminal SKILL_RESULT log line.
//   8. init.lua:39-43 (error_response) delegates ALL escaping to helpers.table_to_json inside a
//      pcall, with a literal {"error":"error encoding failed"} fallback if even that fails. The
//      pre-fix bug (before commit db4a7a5) string-concatenated the error message directly, so any
//      quote or backslash in it broke the JSON. Two different crash shapes are exercised: a
//      guaranteed nil-index crash from a non-in-game command invocation, and a forced backslash+
//      quote injected through an unvalidated argument.
//
// STALE MOD CODE (see CLAUDE.md's "Update mod" / hot-reload gotchas): copying factorio-mod/ into
// the mods dir is NOT enough - a running game keeps executing the control-stage code it loaded at
// the last save load. `game.reload_script()` is reachable over RCON and returns success but does
// NOT reload the mod in a hosted multiplayer game. Main menu -> Host Saved Game (or
// scripts/smoke/test-server.ts, which always starts a fresh process) is the only reload path.
// This suite therefore opens with a decisive behavioural stale/fresh banner and ABORTS (throws)
// rather than scoring anything against stale code: the discriminator (mod >= 0.17.0, T-034) is
// that resource_nearest returns the ore's exact fractional tile-centre, never math.floor'd.
//
// Sections (all against companion 61, run in this order - it needs only two spawns: the initial
// one, alive through A-D, and a respawn for E after D destroys it):
//   A. chat_say delivers the message intact (item 1).
//   B. resource_mine_until accounting with a mixed inventory (item 2).
//   C. A forced Lua error returns JSON that parses (item 8) - run while the companion from A/B is
//      still alive, since one crash path requires a real companion id to resolve.
//   D. companion_disappear spills carried items (item 3) - spills the mixed inventory B built up.
//   E. A companion killed mid-skill surfaces a nonzero exit code + log path (item 7) - fresh spawn.
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t013-review-fixes.ts
import { readFileSync } from "node:fs";
import { connectMCP, connectRCON, callTool, callToolRaw, check, summary, silent } from "./lib";
import { asArray } from "../../src/utils/connection";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Dedicated, otherwise-unused id: t019/t020/t024 use 1, t026 uses 21-24, t021/t022 use 1/31/32,
// t031 uses 41, t034 uses 51.
const TEST_ID = 61;

// Ore-arena candidates: 80-160 tiles from the world origin (not from wherever the companion
// happens to be standing right now) - same convention as t031/t034.
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
const ARENA_SAFETY_RADIUS = 30; // min distance from any enemy spawner/turret/worm
const ORE_CLEAR_RADIUS = 25; // min distance from any PRE-EXISTING resource entity
const ORE_MAIN_AMOUNT = 3000; // generous enough for section B's 8 and section E's 50, with margin

const STATE_SAMPLE_RADIUS = 40;

const SKILL_POLL_BUDGET_MS = 60000;
const SKILL_POLL_INTERVAL_MS = 1000;

const B_SEED_COAL = 30;
const B_SEED_IRON = 3;
const B_TARGET_AMOUNT = 8;
const E_TARGET_AMOUNT = 50;

interface MineUntilSkillResult {
  skill: string;
  companionId: number;
  mined: number;
  target: number;
  success: boolean;
}

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

/** Same convention as t031/t034: a spot clear of BOTH enemy spawners/turrets/worms and any
 *  pre-existing resource entity, so the planted tile is unambiguously the only ore around. */
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

/** Plants one iron-ore tile at (approximately) `pos`. Returns the entity's REAL position - the
 *  teardown key, since resource entities carry no unit_number (nil for simple entities). */
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

/** Remaining iron-ore entities right at `pos` - used before section E to decide whether the
 *  arena tile needs replanting. */
async function countResourceAt(rcon: { send: (cmd: string) => Promise<string> }, pos: { x: number; y: number }, radius = 1): Promise<number> {
  const raw = await silent(
    rcon,
    `
      local s = game.players[1].surface
      local es = s.find_entities_filtered{type="resource", name="iron-ore", position={x=${pos.x}, y=${pos.y}}, radius=${radius}}
      rcon.print(helpers.table_to_json({count = #es}))
    `
  );
  return JSON.parse(raw).count;
}

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

/** Current position, straight off the MCP tool - anchor for every subsequent side-channel lookup. */
async function companionPosition(mcp: { client: any }, id: number): Promise<{ x: number; y: number }> {
  const res = await callTool(mcp.client, "companion_position", { companionId: id });
  if (!res?.position) throw new Error(`companion_position(${id}) returned no position: ${JSON.stringify(res)}`);
  return res.position;
}

/** Ground truth for a single item's main-inventory count, independent of anything the tools
 *  themselves claim. */
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

interface InventoryReadResult {
  items?: { name: string; count: number }[];
  error?: string;
}

/** Full main-inventory contents, aggregated per item name (ignoring quality) - same convention as
 *  the mod's own u.contents_to_map. */
async function readFullInventory(rcon: { send: (cmd: string) => Promise<string> }, x: number, y: number, radius = STATE_SAMPLE_RADIUS): Promise<InventoryReadResult> {
  const raw = await silent(
    rcon,
    findEntityNearLua(x, y, radius) +
      `
      local inv = __target.get_inventory(defines.inventory.character_main)
      local map = {}
      for _, item in pairs(inv.get_contents()) do
        map[item.name] = (map[item.name] or 0) + item.count
      end
      local items = {}
      for name, count in pairs(map) do items[#items + 1] = {name = name, count = count} end
      rcon.print(helpers.table_to_json({items = items}))
    `
  );
  return JSON.parse(raw);
}

async function insertItems(
  rcon: { send: (cmd: string) => Promise<string> },
  x: number,
  y: number,
  items: { name: string; count: number }[],
  radius = STATE_SAMPLE_RADIUS
): Promise<{ inserted?: { name: string; requested: number; inserted: number }[]; error?: string }> {
  const itemsLua = items.map((i) => `{name="${i.name}", count=${i.count}}`).join(", ");
  const raw = await silent(
    rcon,
    findEntityNearLua(x, y, radius) +
      `
      local inv = __target.get_inventory(defines.inventory.character_main)
      local inserted = {}
      for _, item in ipairs({${itemsLua}}) do
        local n = inv.insert{name = item.name, count = item.count}
        inserted[#inserted + 1] = {name = item.name, requested = item.count, inserted = n}
      end
      rcon.print(helpers.table_to_json({inserted = inserted}))
    `
  );
  return JSON.parse(raw);
}

interface CharacterInfo {
  found: boolean;
  unit_number?: number;
  x?: number;
  y?: number;
}

/** unit_number + position of the (non-player) character near (x, y) - characters DO carry a
 *  unit_number, unlike the resource entities elsewhere in this suite's family. */
async function findCharacterInfo(rcon: { send: (cmd: string) => Promise<string> }, x: number, y: number, radius = STATE_SAMPLE_RADIUS): Promise<CharacterInfo> {
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local target
      for _, e in ipairs(surface.find_entities_filtered{name="character", position={x=${x}, y=${y}}, radius=${radius}}) do
        if e.valid and e ~= game.players[1].character then target = e; break end
      end
      if not target then rcon.print(helpers.table_to_json({found = false})); return end
      rcon.print(helpers.table_to_json({found = true, unit_number = target.unit_number, x = target.position.x, y = target.position.y}))
    `
  );
  return JSON.parse(raw);
}

interface GroundItemsResult {
  items: { name: string; count: number }[];
  entityCount: number;
}

/** Ground item-entities near (x, y), aggregated by stack name. Entity COUNT is reported
 *  separately and must never be compared directly against a dropped-items list - a single big
 *  stack splits into several ground entities. */
async function aggregateGroundItemsNear(rcon: { send: (cmd: string) => Promise<string> }, x: number, y: number, radius = 5): Promise<GroundItemsResult> {
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local map = {}
      local entity_count = 0
      for _, e in ipairs(surface.find_entities_filtered{type="item-entity", position={x=${x}, y=${y}}, radius=${radius}}) do
        if e.valid and e.stack and e.stack.valid_for_read then
          map[e.stack.name] = (map[e.stack.name] or 0) + e.stack.count
          entity_count = entity_count + 1
        end
      end
      local items = {}
      for name, count in pairs(map) do items[#items + 1] = {name = name, count = count} end
      rcon.print(helpers.table_to_json({items = items, entityCount = entity_count}))
    `
  );
  return JSON.parse(raw);
}

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

/** Removes any companion at `id` still alive from a previous run (or this run's own) -
 *  fac_companion_disappear clears storage.companions[id] unconditionally, so a subsequent
 *  companion_spawn takes the fresh-spawn branch rather than the {status:"exists"} no-op that
 *  skips spawn-time work entirely. */
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

/** Aggregates two {name,count}[] lists by name and compares summed totals both directions (same
 *  key set, same totals) - the same-day-a-big-stack-splits-into-several-entities trap means
 *  entity/array LENGTH must never be the comparison, only summed counts per name. */
function sameAggregate(a: { name: string; count: number }[], b: { name: string; count: number }[]): boolean {
  const mapA = new Map<string, number>();
  for (const item of a) mapA.set(item.name, (mapA.get(item.name) ?? 0) + item.count);
  const mapB = new Map<string, number>();
  for (const item of b) mapB.set(item.name, (mapB.get(item.name) ?? 0) + item.count);
  if (mapA.size !== mapB.size) return false;
  for (const [name, count] of mapA) {
    if (mapB.get(name) !== count) return false;
  }
  return true;
}

/** Runs one independent section, converting an unexpected throw into a failed check instead of
 *  aborting the whole suite (t022/t031's convention). */
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

  const plantedOrePositions: { x: number; y: number }[] = []; // pushed as soon as planted, so cleanup finds it even if setup throws partway through
  const residuePositions: { x: number; y: number }[] = []; // positions where companion_disappear spilled items - swept in teardown, not immediately

  try {
    // -----------------------------------------------------------
    // Setup: companion 61, fresh
    // -----------------------------------------------------------
    console.log("\n=== Setup: companion 61 ===");
    await clearStaleCompanion(mcp, rcon, TEST_ID);
    const spawnRes = await callTool(mcp.client, "companion_spawn", { companionId: TEST_ID });
    console.log("companion_spawn (61) ->", JSON.stringify(spawnRes));
    check("Setup: companion 61 spawned genuinely fresh (spawned:true, not status:'exists')", spawnRes.spawned === true, JSON.stringify(spawnRes));
    if (spawnRes.spawned !== true) {
      throw new Error(`Companion ${TEST_ID} did not spawn fresh (${JSON.stringify(spawnRes)}) - aborting, every downstream check would be meaningless.`);
    }

    // -----------------------------------------------------------
    // Setup: constructed ore arena (sections B and E need real ore; the banner needs it too)
    // -----------------------------------------------------------
    console.log("\n=== Setup: constructed ore arena ===");
    const arenaSpot = await findSafeOreArenaSpot(rcon, ARENA_ORIGIN);
    console.log("Arena spot ->", JSON.stringify(arenaSpot));
    check("Setup: found an arena spot 80-160 tiles out, clear of spawners/turrets/worms AND clear of any pre-existing resource", arenaSpot.found === true, JSON.stringify(arenaSpot));
    if (!arenaSpot.found) {
      throw new Error(`No safe ore-arena spot found (${JSON.stringify(arenaSpot)}) - aborting, sections B/E cannot run without a controlled arena.`);
    }
    const anchor = { x: arenaSpot.x!, y: arenaSpot.y! };

    const oreMain = await placeOreTile(rcon, anchor, ORE_MAIN_AMOUNT);
    console.log("ORE_MAIN ->", JSON.stringify(oreMain));
    check(`Setup: ore arena tile planted (iron-ore x${ORE_MAIN_AMOUNT})`, oreMain.created === true, JSON.stringify(oreMain));
    if (!oreMain.created) {
      throw new Error(`Failed to plant the arena ore tile (${JSON.stringify(oreMain)}) - aborting, sections B/E cannot run without it.`);
    }
    plantedOrePositions.push({ x: oreMain.x!, y: oreMain.y! });
    let oreMainPos = { x: oreMain.x!, y: oreMain.y! };

    const posBeforeBanner = await companionPosition(mcp, TEST_ID);
    const tpBanner = await teleportCompanion(rcon, posBeforeBanner.x, posBeforeBanner.y, oreMainPos.x, oreMainPos.y);
    console.log("Setup: teleport onto the ore arena ->", JSON.stringify(tpBanner));
    check("Setup: companion teleported onto the ore arena", tpBanner.teleported === true, JSON.stringify(tpBanner));

    // -----------------------------------------------------------
    // Stale/fresh discriminator banner - printed before any scored behavioural check, and it
    // ABORTS (throws) on stale code, per T-034's stricter variant.
    // -----------------------------------------------------------
    console.log("\n=== Banner: is the running mod code >= 0.17.0? ===");
    const bannerRes = await callTool(mcp.client, "resource_nearest", { companionId: TEST_ID, resourceType: "iron-ore" });
    console.log("Banner: resource_nearest(iron-ore) ->", JSON.stringify(bannerRes));
    if (!bannerRes?.position) {
      throw new Error(`Banner: resource_nearest found no iron-ore near the planted arena tile (${JSON.stringify(bannerRes)}) - cannot determine mod freshness, aborting.`);
    }
    const looksFresh = bannerRes.position.x % 1 !== 0 || bannerRes.position.y % 1 !== 0;
    check(
      "Banner: running mod code is >= 0.17.0 (resource_nearest returns the ore's exact fractional tile-centre, not math.floor'd)",
      looksFresh,
      `position=${JSON.stringify(bannerRes.position)} - integer coordinates mean the game is still executing pre-0.17.0 control-stage code`
    );
    if (!looksFresh) {
      throw new Error(
        `STALE MOD CODE: resource_nearest returned integer coordinates ${JSON.stringify(bannerRes.position)}, so the running game is still on pre-0.17.0 code. ` +
          `Copying factorio-mod/ into the mods dir is not enough and game.reload_script() does not help - go to the main menu and Host Saved Game (or use scripts/smoke/test-server.ts), then re-run. Aborting rather than reporting meaningless results.`
      );
    }

    // -----------------------------------------------------------
    // Section A: chat_say delivers the message intact (item 1)
    // -----------------------------------------------------------
    await runSection("A", "chat_say delivers the message intact (item 1)", async () => {
      const a1 = await callTool(mcp.client, "chat_say", { companionId: TEST_ID, message: "$& $$ {radius}" });
      console.log("A1: chat_say('$& $$ {radius}') ->", JSON.stringify(a1));
      check(
        "A1: chat_say returns the literal payload unchanged - $&/$$ are not treated as regex-replacement patterns and {radius} is not re-substituted",
        a1?.said === "$& $$ {radius}",
        JSON.stringify(a1)
      );

      const trickyMsg = 'quote:" backslash:\\ brace:{x} percent:%s tilde:~';
      const a2 = await callTool(mcp.client, "chat_say", { companionId: TEST_ID, message: trickyMsg });
      console.log("A2: chat_say(tricky chars) ->", JSON.stringify(a2));
      check("A2: chat_say survives quote/backslash/brace/percent/tilde unchanged", a2?.said === trickyMsg, JSON.stringify(a2));

      const a3a = await callTool(mcp.client, "chat_say", { companionId: TEST_ID, message: "a  b" });
      console.log("A3a: chat_say('a  b', two spaces via MCP) ->", JSON.stringify(a3a));
      check(
        "A3a (documented MCP normalization): chat_say collapses internal whitespace runs ('a  b' -> 'a b')",
        a3a?.said === "a b",
        JSON.stringify(a3a)
      );

      const a3b = await callTool(mcp.client, "chat_say", { companionId: TEST_ID, message: "  lead/trail  " });
      console.log("A3b: chat_say('  lead/trail  ' via MCP) ->", JSON.stringify(a3b));
      check(
        "A3b (documented MCP normalization): chat_say trims leading/trailing whitespace ('  lead/trail  ' -> 'lead/trail')",
        a3b?.said === "lead/trail",
        JSON.stringify(a3b)
      );

      const a4Raw = await rcon.send(`/fac_chat_say ${TEST_ID} a  b`);
      console.log("A4: raw RCON /fac_chat_say (two spaces, bypassing buildRCONCommand entirely) ->", a4Raw);
      const a4 = JSON.parse(a4Raw);
      check("A4: multi-space DOES survive the Lua/transport half - the collapse is purely a TS templating-layer behavior", a4?.said === "a  b", JSON.stringify(a4));

      const a5Raw = await rcon.send(`/fac_chat_say ${TEST_ID}`);
      console.log("A5: raw RCON /fac_chat_say with no message ->", a5Raw);
      const a5 = JSON.parse(a5Raw);
      check("A5: empty message returns the usage string as a parseable error", typeof a5?.error === "string" && a5.error.includes("Usage"), JSON.stringify(a5));
    });

    // -----------------------------------------------------------
    // Section B: resource_mine_until accounting with a MIXED inventory (item 2)
    // -----------------------------------------------------------
    await runSection("B", "resource_mine_until accounting with a mixed inventory (item 2)", async () => {
      const posB = await companionPosition(mcp, TEST_ID);
      const tpB = await teleportCompanion(rcon, posB.x, posB.y, oreMainPos.x, oreMainPos.y);
      check("B setup: companion teleported onto the ore arena", tpB.teleported === true, JSON.stringify(tpB));

      const seedRes = await insertItems(rcon, oreMainPos.x, oreMainPos.y, [
        { name: "coal", count: B_SEED_COAL },
        { name: "iron-ore", count: B_SEED_IRON },
      ]);
      console.log("B setup: seeded mixed inventory ->", JSON.stringify(seedRes));

      const ironBefore = await readInventoryCount(rcon, oreMainPos.x, oreMainPos.y, "iron-ore");
      const coalBefore = await readInventoryCount(rcon, oreMainPos.x, oreMainPos.y, "coal");
      console.log(`B setup: before mining - iron-ore=${ironBefore}, coal=${coalBefore}`);
      check(
        "B setup: seeded iron-ore is BELOW the requested target (a stack at/above target would make the skill short-circuit and mine nothing)",
        ironBefore < B_TARGET_AMOUNT,
        `ironBefore=${ironBefore} target=${B_TARGET_AMOUNT}`
      );
      check("B setup: seeded coal landed as expected", coalBefore === B_SEED_COAL, `coalBefore=${coalBefore}`);

      const startB = await callToolRaw(mcp.client, "resource_mine_until", { companionId: TEST_ID, resource: "iron-ore", amount: B_TARGET_AMOUNT });
      console.log("B: resource_mine_until (start) ->", startB);

      const { status: statusB, result: resultB, outcome: outcomeB } = await pollUntilSkillDone(mcp, TEST_ID);
      console.log(`B: skill lifecycle outcome=${outcomeB}, companion_status ->`, JSON.stringify(statusB));
      console.log("B: parsed SKILL_RESULT ->", JSON.stringify(resultB));
      check("B: skill lifecycle completed within the poll budget (did not time out while still running)", outcomeB === "done", `outcome=${outcomeB}`);

      const logPathB: string | undefined = statusB?.lastSkillResult?.logPath;
      const logTextB = typeof logPathB === "string" ? readFileSync(logPathB, "utf8") : "";
      const logShowsMining = /Mined \d+, total:/.test(logTextB);
      console.log(`B1: log evidence of actual mining present = ${logShowsMining}`);
      check(
        "B1: the skill actually mined (did NOT short-circuit on the pre-existing partial stack) - the log shows a 'Mined N, total: ...' line and SKILL_RESULT.mined >= the target",
        logShowsMining && (resultB?.mined ?? -1) >= B_TARGET_AMOUNT,
        JSON.stringify({ logShowsMining, resultMined: resultB?.mined })
      );

      const posAfterB = await companionPosition(mcp, TEST_ID);
      const ironAfter = await readInventoryCount(rcon, posAfterB.x, posAfterB.y, "iron-ore");
      const coalAfter = await readInventoryCount(rcon, posAfterB.x, posAfterB.y, "coal");
      const newlyMinedIron = ironAfter - ironBefore;
      console.log(`B: after mining - iron-ore=${ironAfter} (before=${ironBefore}, newly mined=${newlyMinedIron}), coal=${coalAfter}`);
      // Observational note (see header comment on item 2): mine-until.ts's per-attempt mining
      // target is `targetAmount - totalMined`, not `targetAmount - currentInventoryCount`, so a
      // pre-existing PARTIAL stack is not subtracted from what actually gets mined - only a
      // stack already at/above the target trips the short-circuit (checked in "B setup" above).
      // Logging both readings rather than hard-coding one, per the brief's own instruction.
      console.log(
        `B2 (observed, unscored): newlyMinedIron=${newlyMinedIron}; a subtract-existing-stock reading would show ~${B_TARGET_AMOUNT - B_SEED_IRON}, ` +
          `an ignore-existing-stock reading would show ~${B_TARGET_AMOUNT} (both +/- whole-ore overshoot)`
      );
      check(
        "B2: final iron-ore inventory satisfies resource_mine_until's own success contract (final >= requested amount)",
        ironAfter >= B_TARGET_AMOUNT,
        `ironAfter=${ironAfter} target=${B_TARGET_AMOUNT}`
      );

      check("B3: pre-existing coal stack is UNCHANGED - it was neither consumed nor counted", coalAfter === coalBefore, `coalBefore=${coalBefore} coalAfter=${coalAfter}`);

      const statusAfterB = await callTool(mcp.client, "resource_mine_status", { companionId: TEST_ID });
      console.log("B4: terminal resource_mine_status (storage.harvest_results survives queue deletion) ->", JSON.stringify(statusAfterB));
      const modHarvested = statusAfterB?.status?.harvested;
      check(
        "B4 (THE POINT OF THIS SECTION): the mod's own harvested counter equals the independently-measured newly-mined iron delta - NOT the absolute final iron count, and NOT combined iron+coal inventory",
        typeof modHarvested === "number" && modHarvested === newlyMinedIron,
        JSON.stringify({ modHarvested, newlyMinedIron, finalIronAlone: ironAfter, combinedIronPlusCoal: ironAfter + coalAfter })
      );

      check("B5: SKILL_RESULT reports success:true", resultB?.success === true, JSON.stringify(resultB));
      check("B5: lastSkillResult.exitCode === 0", statusB?.lastSkillResult?.exitCode === 0, JSON.stringify(statusB?.lastSkillResult));
    });

    // -----------------------------------------------------------
    // Section C: a forced Lua error returns JSON that parses (item 8)
    // -----------------------------------------------------------
    await runSection("C", "a forced Lua error returns JSON that parses (item 8)", async () => {
      // C1: guaranteed crash path. cmd.player_index is nil for a non-in-game RCON invocation, so
      // once "61" resolves to a real companion (requires the companion from A/B still alive),
      // control.lua's handle_fac indexes the nil `player` local and safe_command's pcall routes
      // it to error_response.
      const c1Raw = await rcon.send(`/fac ${TEST_ID} hello`);
      console.log("C1: raw RCON /fac 61 hello (raw bytes) ->", c1Raw);
      let c1: any;
      let c1Parsed = false;
      try {
        c1 = JSON.parse(c1Raw);
        c1Parsed = true;
      } catch {
        /* left unparsed, scored below */
      }
      check("C1a: the reply JSON.parses without throwing", c1Parsed, c1Raw);
      check("C1b: the parsed value is an OBJECT, not a string", c1Parsed && typeof c1 === "object" && c1 !== null, JSON.stringify(c1));
      check("C1c: parsed.error is a string", c1Parsed && typeof c1?.error === "string", JSON.stringify(c1));
      // Lua's runtime phrasing is "attempt to index local 'player' (a nil value)" - the
      // "(a nil value)" suffix comes AFTER the variable name, so a naive
      // .includes("attempt to index a nil value") never matches. Assert the stable parts
      // (the raising site and both halves of the message) rather than one exact sentence.
      check(
        "C1d: parsed.error carries the raising site and the nil-index cause (control.lua:121, 'attempt to index' ... 'nil value')",
        c1Parsed &&
          typeof c1?.error === "string" &&
          c1.error.includes("control.lua:121") &&
          c1.error.includes("attempt to index") &&
          c1.error.includes("nil value"),
        JSON.stringify(c1)
      );

      // C2: force \ and " into the message via fac_building_fuel's unvalidated fuel-name arg
      // (building.lua interpolates it into "No " .. fuel on the have==0 branch).
      const c2Raw = await rcon.send(`/fac_building_fuel ${TEST_ID} a\\b"c`);
      console.log('C2: raw RCON /fac_building_fuel 61 a\\b"c (raw bytes) ->', c2Raw);
      let c2: any;
      let c2Parsed = false;
      try {
        c2 = JSON.parse(c2Raw);
        c2Parsed = true;
      } catch {
        /* left unparsed, scored below */
      }
      check("C2a: the reply parses as an OBJECT", c2Parsed && typeof c2 === "object" && c2 !== null, JSON.stringify(c2));
      check("C2b: the reply has a string error field", c2Parsed && typeof c2?.error === "string", JSON.stringify(c2));
      const c2ContainsLiteral = c2Parsed && typeof c2?.error === "string" && c2.error.includes('a\\b"c');
      // Which side raised is genuinely either-or (the brief allowed both), so classify from the
      // MESSAGE, not from whether the literals survived - the two are independent and conflating
      // them mislabelled the first run. "Unknown item name" exists nowhere in factorio-mod/ or
      // src/, so it is the ENGINE's get_item_count validation raising on the bogus prototype.
      const c2FromEngine = c2Parsed && typeof c2?.error === "string" && !c2.error.startsWith("No ");
      console.log(
        `C2 (unscored observation): raised by ${c2FromEngine ? "the ENGINE (get_item_count on a bogus prototype name)" : "the mod's own 'No <fuel>' branch (building.lua have==0 path)"}` +
          ` - error was: ${JSON.stringify(c2?.error)}`
      );
      // Scored regardless of which side raised: BOTH paths echo the caller's argument, so the
      // backslash and double-quote must survive helpers.table_to_json's escaping either way.
      // This is the decisive check for item 8 - the pre-db4a7a5 code string-concatenated the
      // message into '{"error":"' .. msg .. '"}', which these exact characters would break.
      check(
        'C2c: the literal characters a\\b"c survive escaping intact (the historical raw-concatenation bug would emit unparseable JSON here)',
        c2ContainsLiteral,
        `error=${JSON.stringify(c2?.error)}`
      );

      // C3: same crash class, but through the MCP callTool wrapper - proves the JSON survives
      // the FULL round trip (buildRCONCommand -> execRCON -> callTool's own JSON.parse), not
      // just raw RCON. lib.ts's callTool silently falls back to the raw string on a parse
      // failure, so a naive `parsed.error !== undefined` check would pass even on a STRING.
      const c3 = await callTool(mcp.client, "building_fuel", { companionId: TEST_ID, fuelName: 'a\\b"c', count: 5 });
      console.log("C3: callTool(building_fuel, tricky fuelName) ->", JSON.stringify(c3));
      check("C3: callTool returns a genuine parsed OBJECT (not lib.ts's raw-string fallback)", typeof c3 === "object" && c3 !== null, JSON.stringify(c3));
      check("C3: the object has a string error field", typeof c3?.error === "string", JSON.stringify(c3));
    });

    // -----------------------------------------------------------
    // Section D: companion_disappear spills carried items (item 3)
    // -----------------------------------------------------------
    await runSection("D", "companion_disappear spills carried items (item 3)", async () => {
      const posD = await companionPosition(mcp, TEST_ID);

      const invBeforeRes = await readFullInventory(rcon, posD.x, posD.y);
      const invBefore = asArray<{ name: string; count: number }>(invBeforeRes?.items);
      console.log("D1: full inventory before disappear (holds the coal + iron from section B) ->", JSON.stringify(invBefore));
      check("D1: pre-disappear inventory read succeeded and is non-empty", invBefore.length > 0, JSON.stringify(invBefore));

      const charInfo = await findCharacterInfo(rcon, posD.x, posD.y);
      console.log("D2: companion character info before disappear ->", JSON.stringify(charInfo));
      check("D2: recorded the companion's unit_number before destroying it", charInfo.found === true && typeof charInfo.unit_number === "number", JSON.stringify(charInfo));

      const disappearD = await callTool(mcp.client, "companion_disappear", { companionId: TEST_ID });
      console.log("D3: companion_disappear ->", JSON.stringify(disappearD));
      check("D3: disappeared:true", disappearD?.disappeared === true, JSON.stringify(disappearD));
      const dropped = asArray<{ name: string; count: number }>(disappearD?.dropped);

      check(
        "D4: dropped report matches the pre-disappear inventory - same item names, same summed counts, both directions",
        sameAggregate(invBefore, dropped),
        JSON.stringify({ invBefore, dropped })
      );

      const groundRes = await aggregateGroundItemsNear(rcon, posD.x, posD.y, 5);
      const groundItems = groundRes.items;
      console.log("D5: ground items independently aggregated ->", JSON.stringify(groundItems), "entityCount:", groundRes.entityCount);
      check(
        "D5: independently-swept ground items match dropped by SUMMED COUNT PER NAME (a big stack can split into several ground entities, so entity count is never the comparison)",
        sameAggregate(dropped, groundItems),
        JSON.stringify({ dropped, groundItems, entityCount: groundRes.entityCount })
      );

      const charAfter = await findCharacterInfo(rcon, posD.x, posD.y);
      console.log("D6: character search after disappear ->", JSON.stringify(charAfter));
      check(
        "D6: no character entity with the recorded unit_number survives",
        !(charAfter.found === true && charAfter.unit_number === charInfo.unit_number),
        JSON.stringify({ before: charInfo, after: charAfter })
      );

      const listAfterD = await callTool(mcp.client, "companion_list", {});
      const companionsAfterD = asArray<{ id: number }>(listAfterD?.companions);
      check("D6: companion_list no longer lists 61", !companionsAfterD.some((c) => c.id === TEST_ID), JSON.stringify(companionsAfterD));

      const posAfterD = await callTool(mcp.client, "companion_position", { companionId: TEST_ID });
      console.log("D6: companion_position after disappear ->", JSON.stringify(posAfterD));
      check("D6: companion_position now returns an error", typeof posAfterD?.error === "string", JSON.stringify(posAfterD));

      // Recorded for teardown - destroyed at the very end, not here (per the brief).
      residuePositions.push({ x: posD.x, y: posD.y });
    });

    // -----------------------------------------------------------
    // Section E: a companion killed mid-skill surfaces a nonzero exit code + log path (item 7)
    // -----------------------------------------------------------
    await runSection("E", "a companion killed mid-skill surfaces a nonzero exit code + log path (item 7)", async () => {
      await clearStaleCompanion(mcp, rcon, TEST_ID);
      const spawnE = await callTool(mcp.client, "companion_spawn", { companionId: TEST_ID });
      console.log("E setup: companion_spawn (respawn, second and last spawn of this suite) ->", JSON.stringify(spawnE));
      check("E setup: companion 61 respawned genuinely fresh", spawnE.spawned === true, JSON.stringify(spawnE));
      if (spawnE.spawned !== true) {
        throw new Error(`Companion ${TEST_ID} did not respawn fresh for section E (${JSON.stringify(spawnE)}) - aborting this section.`);
      }

      const posBeforeE = await companionPosition(mcp, TEST_ID);
      const tpE = await teleportCompanion(rcon, posBeforeE.x, posBeforeE.y, oreMainPos.x, oreMainPos.y);
      check("E setup: companion teleported onto the ore arena", tpE.teleported === true, JSON.stringify(tpE));

      const remainingOre = await countResourceAt(rcon, oreMainPos);
      console.log(`E setup: remaining ore at the arena tile -> ${remainingOre}`);
      if (remainingOre === 0) {
        const replant = await placeOreTile(rcon, oreMainPos, ORE_MAIN_AMOUNT);
        console.log("E setup: earlier tile was consumed, replanted ->", JSON.stringify(replant));
        check("E setup: replanted ore after depletion", replant.created === true, JSON.stringify(replant));
        if (replant.created) {
          oreMainPos = { x: replant.x!, y: replant.y! };
          plantedOrePositions.push(oreMainPos);
        }
      }

      const startE = await callToolRaw(mcp.client, "resource_mine_until", { companionId: TEST_ID, resource: "iron-ore", amount: E_TARGET_AMOUNT });
      console.log("E1: resource_mine_until (start, large target so it's genuinely long-running) ->", startE);

      await sleep(1000);
      const statusRunningE = await callTool(mcp.client, "companion_status", { companionId: TEST_ID });
      console.log("E2: companion_status shortly after starting ->", JSON.stringify(statusRunningE));
      check(
        "E2: the skill is genuinely running (skill.running:true with a pid) before we kill it - otherwise this section proves nothing",
        statusRunningE?.skill?.running === true && typeof statusRunningE?.skill?.pid === "number",
        JSON.stringify(statusRunningE)
      );
      if (statusRunningE?.skill?.running !== true) {
        throw new Error(`Skill was not running when E3 needs to kill it mid-flight (${JSON.stringify(statusRunningE)}) - aborting this section.`);
      }

      const posBeforeKillE = await companionPosition(mcp, TEST_ID);
      const disappearE = await callTool(mcp.client, "companion_disappear", { companionId: TEST_ID });
      console.log("E3: companion_disappear (killed mid-skill - NOT companion_stop, which would overwrite the result with exitCode:null) ->", JSON.stringify(disappearE));
      check("E3: companion_disappear succeeded", disappearE?.disappeared === true, JSON.stringify(disappearE));
      residuePositions.push(posBeforeKillE);

      // companion_disappear is deliberately NOT in server.ts's AUTO_STOP_TOOLS - stopCompanionSkill
      // never runs, so exitCode:null ("killed, not self-terminated") is never written here. The
      // skill process itself has to notice the companion is gone - every RCON call it makes now
      // gets back {error:"Companion not found"} - and exit on its own. Same convention as t024:
      // an initial sleep for the async `exit` event, then poll.
      let statusE: any = null;
      let stillRunning = true;
      const pollStartE = Date.now();
      while (Date.now() - pollStartE < SKILL_POLL_BUDGET_MS) {
        await sleep(500);
        statusE = await callTool(mcp.client, "companion_status", { companionId: TEST_ID });
        if (statusE?.skill?.running !== true) {
          stillRunning = false;
          break;
        }
      }
      console.log(`E4: skill stopped running=${!stillRunning} after ${Date.now() - pollStartE}ms, companion_status ->`, JSON.stringify(statusE));
      check("E4 (Done-when): the skill process eventually stopped running after being killed mid-flight", !stillRunning, JSON.stringify(statusE));

      check(
        "E5 (Done-when): lastSkillResult.exitCode === 1, explicitly NOT null (null would mean stopCompanionSkill ran, which companion_disappear must never trigger)",
        statusE?.lastSkillResult?.exitCode === 1,
        JSON.stringify(statusE?.lastSkillResult)
      );

      const logPathE: string | undefined = statusE?.lastSkillResult?.logPath;
      check("E6: lastSkillResult.logPath is a non-empty string", typeof logPathE === "string" && logPathE.length > 0, JSON.stringify(statusE?.lastSkillResult));

      // A connection failure also yields exit 1 (mine-until.ts's catch block) - exitCode alone
      // can't distinguish "noticed the companion is gone and gave up cleanly" from "genuinely
      // crashed for an unrelated reason", so assert on the log's own terminal SKILL_RESULT line
      // too, not just the numeric exit code.
      if (typeof logPathE === "string" && logPathE.length > 0) {
        const logContentE = readFileSync(logPathE, "utf8");
        const resultE = parseSkillResultLog(logPathE);
        console.log("E6: parsed terminal SKILL_RESULT from log ->", JSON.stringify(resultE));
        check("E6: the log file exists and its terminal SKILL_RESULT line parses", resultE !== null, logContentE.slice(-500));
        check("E6: the terminal SKILL_RESULT reports success:false", resultE?.success === false, JSON.stringify(resultE));
        check("E7 (Done-when): lastSkillResult.skillName === 'resource_mine_until'", statusE?.lastSkillResult?.skillName === "resource_mine_until", JSON.stringify(statusE?.lastSkillResult));
        console.log(`E7 (unscored observation): the script's own SKILL_RESULT.skill self-report = ${JSON.stringify(resultE?.skill)}`);
      } else {
        check("E6: the log file exists and its terminal SKILL_RESULT line parses", false, "no logPath to read");
        check("E7 (Done-when): lastSkillResult.skillName === 'resource_mine_until'", false, "no logPath to read");
      }
    });
  } finally {
    console.log("\n--- Cleanup ---");

    try {
      const stopMine = await callToolRaw(mcp.client, "resource_mine_stop", { companionId: TEST_ID });
      console.log("Cleanup: resource_mine_stop ->", stopMine);
    } catch (e) {
      console.log("Cleanup resource_mine_stop failed (reporting, not hiding):", e);
    }

    try {
      await clearStaleCompanion(mcp, rcon, TEST_ID);
    } catch (e) {
      console.log("Cleanup companion_disappear failed (reporting, not hiding):", e);
    }

    if (residuePositions.length > 0) {
      try {
        let totalDestroyed = 0;
        for (const pos of residuePositions) {
          totalDestroyed += await destroyGroundResidue(rcon, pos.x, pos.y);
        }
        console.log(`Cleanup: destroyed ${totalDestroyed} spilled ground-residue entities across ${residuePositions.length} recorded companion position(s)`);
      } catch (e) {
        console.log("Cleanup ground-residue removal failed (reporting, not hiding):", e);
      }
    }

    if (plantedOrePositions.length > 0) {
      try {
        const destroyedOre = await destroyOreTiles(rcon, plantedOrePositions);
        console.log("Cleanup: destroyed planted ore tiles ->", JSON.stringify(destroyedOre), `(planted ${plantedOrePositions.length})`);
      } catch (e) {
        console.log("Cleanup ore-tile removal failed (reporting, not hiding):", e);
      }
    }

    try {
      await mcp.close();
    } catch (e) {
      console.log("Cleanup mcp.close() failed (reporting, not hiding):", e);
    }
    try {
      await rcon.close();
    } catch (e) {
      console.log("Cleanup rcon.close() failed (reporting, not hiding):", e);
    }
  }

  process.exit(summary());
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
