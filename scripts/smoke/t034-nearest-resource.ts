// Live smoke test for T-034: "resource_nearest actually returns the NEAREST resource"
// (factorio-mod/commands/init.lua u.find_nearest, resource.lua fac_resource_nearest,
// world.lua fac_world_nearest - mod 0.17.0).
//
// Contract under test:
//   - find_entities_filtered's `limit` truncates in the engine's own chunk order, which carries
//     NO distance ordering. The pre-0.17.0 code scanned a +/-200 square with limit=100 and then
//     picked the minimum from whatever came back, so the true nearest could be excluded from the
//     sample outright - "nearest of an arbitrary sample", not "nearest". u.find_nearest instead
//     grows an UNLIMITED circular search (8 -> 16 -> 32 -> 64 -> 128 -> 200), which is complete
//     by construction: whatever the first non-empty circle contains, everything omitted lies
//     outside that circle and so is farther than its radius.
//   - resource_nearest returns the entity's EXACT position, not math.floor'd. Ore sits at tile
//     centres (x.5, y.5), so flooring reported a point ~0.71 tiles off the real entity - spent
//     straight out of the engine's 2.7-tile resource_reach_distance before the caller had walked
//     anywhere. Reported distance is likewise unfloored (flooring under-reported it, so a caller
//     comparing against its reach could skip a walk it actually needed).
//   - world_nearest got the identical treatment on all three of its branches (named entity,
//     tree, water tiles).
//
// VERIFICATION STRATEGY. The Done-when asks for a live check "against an independent
// find_entities_filtered sweep from the same position", so every scored comparison here is
// three-way, computed over the RCON side channel at the companion's exact current position:
//   tool  - what fac_resource_nearest / fac_world_nearest reply
//   truth - an independent UNLIMITED sweep, minimum taken in the harness
//   old   - a faithful REPLAY of the pre-0.17.0 algorithm (same +/-200 square, same limit=100,
//           same pick-the-minimum), so a green run can also show that the bug was real on this
//           map at this position without needing to redeploy the old mod
// `tool == truth` is the assertion. `old != truth` is recorded as the discriminating evidence,
// and section A fails if NO resource type discriminates - otherwise the whole suite could pass
// vacuously on a map where the truncation happens to be harmless.
//
// The replay was validated against the genuinely-deployed old code before this suite existed
// (2026-07-26, mod 0.16.0 running): replay said iron-ore at 106.95 / (-73.5,-75.5) and the live
// 0.16.0 tool said 106 / (-74,-76) - the same entity, differing only by the flooring the replay
// deliberately omits. So the replay models the old code rather than merely resembling it.
//
// STALE MOD CODE (see CLAUDE.md's "Update mod" / hot-reload gotchas): copying factorio-mod/ into
// the mods dir is NOT enough - a running game keeps executing the control-stage code it loaded at
// the last save load, and `game.reload_script()` does NOT reload it in a hosted multiplayer game.
// Main menu -> Host Saved Game is the only reload path. This suite therefore opens with a
// behavioural stale/fresh banner and REFUSES to score anything against stale code: the
// discriminator is that <=0.16.0 math.floor'd the returned coordinates, so an integer-valued
// position means old code (planted and natural ore alike always sit at tile centres, x.5/y.5,
// so a fresh reply is never integer-valued).
//
// Sections (all against companion 51):
//   A. Natural map, four resource types: tool == independent unlimited sweep, and at least one
//      type is one the old limited scan got WRONG.
//   B. Exact coordinates: the reply is the entity's real position (not floored), the distance is
//      the real euclidean distance (not floored), and the old flooring is quantified.
//   C. Constructed arena: with three planted tiles at 3 / 7 / 20 tiles, the 3-tile one wins -
//      deterministic min-picking, independent of whatever the live map happens to look like.
//   D. world_nearest got the same fix (tree branch and water branch).
//   E. Regressions: an absent resource still reports {error:"Not found"} rather than hanging or
//      throwing, and resource_mine_until still works end-to-end now that it consumes fractional
//      coordinates instead of integers.
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t034-nearest-resource.ts
import { readFileSync } from "node:fs";
import { connectMCP, connectRCON, callTool, callToolRaw, check, summary, silent, EPS } from "./lib";
import { asArray } from "../../src/utils/connection";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Dedicated, otherwise-unused id: t019/t020/t024 use 1, t026 uses 21-24, t021/t022 use 1/31/32,
// t031 uses 41.
const NEAREST_ID = 51;

// Must match u.SEARCH_MAX_RADIUS in factorio-mod/commands/init.lua. The mod searches a CIRCLE of
// this radius; the ground-truth sweep below scans the enclosing square and then discards anything
// beyond it, so the two are compared over the same region rather than the tool being blamed for
// legitimately not seeing a square corner at distance ~283.
const SEARCH_MAX_RADIUS = 200;

const RESOURCE_TYPES = ["iron-ore", "copper-ore", "coal", "stone"];

// Arena (section C): same convention as t031 - a spot 80-160 tiles out, verified clear of enemy
// spawners/turrets/worms AND of any pre-existing resource, so the planted tiles are unambiguously
// the only ore around and teardown can be exact.
const ARENA_ORIGIN = { x: 0, y: 0 };
const ARENA_CANDIDATE_OFFSETS: Array<{ dx: number; dy: number }> = [
  { dx: 80, dy: 0 }, { dx: 0, dy: 80 }, { dx: -80, dy: 0 }, { dx: 0, dy: -80 },
  { dx: 120, dy: 120 }, { dx: -120, dy: 120 }, { dx: 120, dy: -120 }, { dx: -120, dy: -120 },
  { dx: 160, dy: 0 }, { dx: 0, dy: 160 }, { dx: -160, dy: 0 }, { dx: 0, dy: -160 },
];
const ARENA_SAFETY_RADIUS = 30;
const ORE_CLEAR_RADIUS = 25; // > the 20-tile decoy below, so all three planted tiles land on verified-clear ground

// Offsets from the arena anchor. NEAR and MID both fall inside the mod's FIRST search ring
// (radius 8), so the tool has to pick the minimum WITHIN a ring rather than merely stopping at
// the first ring that contains anything; FAR sits in the third ring (radius 32) and would win
// outright if ring ordering were broken.
const ORE_NEAR_OFFSET = { dx: 3, dy: 0 };
const ORE_MID_OFFSET = { dx: 7, dy: 0 };
const ORE_FAR_OFFSET = { dx: 20, dy: 0 };
const ARENA_ORE_AMOUNT = 500;

const STATE_SAMPLE_RADIUS = 40;
const SKILL_POLL_BUDGET_MS = 60000;
const SKILL_POLL_INTERVAL_MS = 1000;

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

interface Sweep {
  old_count: number;
  total_count: number;
  in_range_count: number;
  old_distance?: number;
  old_position?: { x: number; y: number };
  true_distance?: number;
  true_position?: { x: number; y: number };
}

/** Independent ground truth for an ENTITY search, computed engine-side at `pos`.
 *
 *  Returns both the replayed pre-0.17.0 answer (square + limit=100 + pick-min) and the real
 *  answer (unlimited, restricted to the mod's actual circular search region). Deliberately does
 *  NOT go through any mod command - this is the check on the mod, so it must not share code with
 *  it. `filter_key` is "name" or "type" to mirror u.find_nearest's two call shapes. */
async function sweepEntities(
  rcon: { send: (cmd: string) => Promise<string> },
  pos: { x: number; y: number },
  filterKey: "name" | "type",
  filterValue: string
): Promise<Sweep> {
  const raw = await silent(
    rcon,
    `
      local s = game.players[1].surface
      local pos = {x=${pos.x}, y=${pos.y}}
      local area = {{pos.x-${SEARCH_MAX_RADIUS}, pos.y-${SEARCH_MAX_RADIUS}}, {pos.x+${SEARCH_MAX_RADIUS}, pos.y+${SEARCH_MAX_RADIUS}}}
      local function d(p) return math.sqrt((p.x-pos.x)^2 + (p.y-pos.y)^2) end
      -- replay of the pre-0.17.0 algorithm, exactly as it was written
      local old_es = s.find_entities_filtered{area=area, ${filterKey}="${filterValue}", limit=100}
      local old_p, old_min = nil, math.huge
      for _, e in ipairs(old_es) do local dd = d(e.position); if dd < old_min then old_min, old_p = dd, e.position end end
      -- ground truth: unlimited, then restricted to the circle the mod actually searches
      local all = s.find_entities_filtered{area=area, ${filterKey}="${filterValue}"}
      local true_p, true_min, in_range = nil, math.huge, 0
      for _, e in ipairs(all) do
        local dd = d(e.position)
        if dd <= ${SEARCH_MAX_RADIUS} then
          in_range = in_range + 1
          if dd < true_min then true_min, true_p = dd, e.position end
        end
      end
      rcon.print(helpers.table_to_json({
        old_count = #old_es, total_count = #all, in_range_count = in_range,
        old_distance = (old_p and old_min or nil), old_position = old_p,
        true_distance = (true_p and true_min or nil), true_position = true_p
      }))
    `
  );
  return JSON.parse(raw);
}

/** Tile equivalent of sweepEntities, for world_nearest's water branch. */
async function sweepTiles(
  rcon: { send: (cmd: string) => Promise<string> },
  pos: { x: number; y: number },
  names: string[]
): Promise<Sweep> {
  const nameList = names.map((n) => `"${n}"`).join(", ");
  const raw = await silent(
    rcon,
    `
      local s = game.players[1].surface
      local pos = {x=${pos.x}, y=${pos.y}}
      local area = {{pos.x-${SEARCH_MAX_RADIUS}, pos.y-${SEARCH_MAX_RADIUS}}, {pos.x+${SEARCH_MAX_RADIUS}, pos.y+${SEARCH_MAX_RADIUS}}}
      local function d(p) return math.sqrt((p.x-pos.x)^2 + (p.y-pos.y)^2) end
      local old_ts = s.find_tiles_filtered{area=area, name={${nameList}}, limit=100}
      local old_p, old_min = nil, math.huge
      for _, t in ipairs(old_ts) do local dd = d(t.position); if dd < old_min then old_min, old_p = dd, t.position end end
      local all = s.find_tiles_filtered{area=area, name={${nameList}}}
      local true_p, true_min, in_range = nil, math.huge, 0
      for _, t in ipairs(all) do
        local dd = d(t.position)
        if dd <= ${SEARCH_MAX_RADIUS} then
          in_range = in_range + 1
          if dd < true_min then true_min, true_p = dd, t.position end
        end
      end
      rcon.print(helpers.table_to_json({
        old_count = #old_ts, total_count = #all, in_range_count = in_range,
        old_distance = (old_p and old_min or nil), old_position = old_p,
        true_distance = (true_p and true_min or nil), true_position = true_p
      }))
    `
  );
  return JSON.parse(raw);
}

interface ArenaSpot { found: boolean; x?: number; y?: number }

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
      if chosen_x then rcon.print(helpers.table_to_json({found = true, x = chosen_x, y = chosen_y}))
      else rcon.print(helpers.table_to_json({found = false})) end
    `
  );
  return JSON.parse(raw);
}

interface OreTileResult { created: boolean; x?: number; y?: number }

/** Plants one iron-ore tile, returning its REAL position - the teardown key. Resource entities
 *  carry no unit_number (nil for simple entities), so identity-by-unit_number silently tracks
 *  nothing and leaves every planted tile behind in the player's world (this cost t031 four runs
 *  of littering before it was noticed). */
async function placeOreTile(rcon: { send: (cmd: string) => Promise<string> }, pos: { x: number; y: number }, amount: number): Promise<OreTileResult> {
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local spot = surface.find_non_colliding_position("iron-ore", {x=${pos.x}, y=${pos.y}}, 5, 0.5) or {x=${pos.x}, y=${pos.y}}
      local e = surface.create_entity{name="iron-ore", amount=${amount}, position=spot}
      if e and e.valid then rcon.print(helpers.table_to_json({created = true, x = e.position.x, y = e.position.y}))
      else rcon.print(helpers.table_to_json({created = false})) end
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

/** Counts resource entities remaining near the arena anchor - independent proof that teardown
 *  actually removed what it planted, rather than silently no-opping. */
async function countResourcesNear(rcon: { send: (cmd: string) => Promise<string> }, pos: { x: number; y: number }, radius: number): Promise<number> {
  const raw = await silent(
    rcon,
    `
      local s = game.players[1].surface
      local es = s.find_entities_filtered{type="resource", position={x=${pos.x}, y=${pos.y}}, radius=${radius}}
      rcon.print(helpers.table_to_json({count = #es}))
    `
  );
  return JSON.parse(raw).count;
}

async function teleportCompanion(
  rcon: { send: (cmd: string) => Promise<string> },
  curX: number, curY: number, destX: number, destY: number,
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

function parseSkillResultLog(logPath: string): MineUntilSkillResult | null {
  const content = readFileSync(logPath, "utf8");
  const lines = content.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i]!.indexOf("SKILL_RESULT ");
    if (idx !== -1) return JSON.parse(lines[i]!.slice(idx + "SKILL_RESULT ".length));
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

async function runSection(label: string, banner: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  try {
    await body();
  } catch (e) {
    check(`${label}: section ran to completion without an unexpected throw`, false, e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
  }
}

/** Current position, straight off the entity - every three-way comparison must be anchored at the
 *  exact same point the mod itself will read, or the distances are not comparable. */
async function companionPosition(mcp: { client: any }, id: number): Promise<{ x: number; y: number }> {
  const res = await callTool(mcp.client, "companion_position", { companionId: id });
  if (!res?.position) throw new Error(`companion_position(${id}) returned no position: ${JSON.stringify(res)}`);
  return res.position;
}

async function main() {
  const mcp = await connectMCP();
  const rcon = await connectRCON();

  const plantedOrePositions: { x: number; y: number }[] = [];
  let arenaAnchor: { x: number; y: number } | null = null;

  try {
    // -----------------------------------------------------------
    // Setup: companion 51, fresh
    // -----------------------------------------------------------
    console.log("\n=== Setup: companion 51 ===");
    await clearStaleCompanion(mcp, rcon, NEAREST_ID);
    const spawnRes = await callTool(mcp.client, "companion_spawn", { companionId: NEAREST_ID });
    console.log("companion_spawn (51) ->", JSON.stringify(spawnRes));
    check("Setup: companion 51 spawned genuinely fresh (spawned:true, not status:'exists')", spawnRes.spawned === true, JSON.stringify(spawnRes));
    if (spawnRes.spawned !== true) {
      throw new Error(`Companion ${NEAREST_ID} did not spawn fresh (${JSON.stringify(spawnRes)}) - aborting, every downstream check would be meaningless.`);
    }

    // -----------------------------------------------------------
    // Stale/fresh banner - refuse to score anything against old code
    // -----------------------------------------------------------
    console.log("\n=== Banner: is the RUNNING mod code 0.17.0? ===");
    const bannerPos = await companionPosition(mcp, NEAREST_ID);
    const bannerRes = await callTool(mcp.client, "resource_nearest", { companionId: NEAREST_ID, resourceType: "iron-ore" });
    console.log(`Banner: companion at ${JSON.stringify(bannerPos)}, resource_nearest(iron-ore) ->`, JSON.stringify(bannerRes));
    if (!bannerRes?.position) {
      throw new Error(`Banner: resource_nearest found no iron-ore at all (${JSON.stringify(bannerRes)}) - cannot determine mod freshness, and section A has nothing to check. Move the player nearer some ore and re-run.`);
    }
    const bannerIsFloored = Number.isInteger(bannerRes.position.x) && Number.isInteger(bannerRes.position.y);
    check(
      "Banner: running mod code is 0.17.0 (returned coordinates are the ore's real tile-centre, not math.floor'd)",
      !bannerIsFloored,
      `position=${JSON.stringify(bannerRes.position)} - integer coordinates mean the game is still executing <=0.16.0 control-stage code`
    );
    if (bannerIsFloored) {
      throw new Error(
        `STALE MOD CODE: resource_nearest returned integer coordinates ${JSON.stringify(bannerRes.position)}, so the running game is still on pre-0.17.0 code. ` +
        `Copying factorio-mod/ into the mods dir is not enough and game.reload_script() does not help - go to the main menu and Host Saved Game, then re-run. Aborting rather than reporting meaningless results.`
      );
    }

    // -----------------------------------------------------------
    // Section A: tool == independent unlimited sweep, on the natural map
    // -----------------------------------------------------------
    let discriminatingTypes = 0;
    await runSection("A", "resource_nearest agrees with an independent unlimited sweep (four resource types)", async () => {
      for (const resourceType of RESOURCE_TYPES) {
        const pos = await companionPosition(mcp, NEAREST_ID);
        const tool = await callTool(mcp.client, "resource_nearest", { companionId: NEAREST_ID, resourceType });
        const sweep = await sweepEntities(rcon, pos, "name", resourceType);

        console.log(`\nA/${resourceType}: companion at ${JSON.stringify(pos)}`);
        console.log(`  tool  -> distance=${tool.distance} position=${JSON.stringify(tool.position)}`);
        console.log(`  truth -> distance=${sweep.true_distance} position=${JSON.stringify(sweep.true_position)} (${sweep.in_range_count} in range of ${sweep.total_count} in the square)`);
        console.log(`  old   -> distance=${sweep.old_distance} position=${JSON.stringify(sweep.old_position)} (sampled ${sweep.old_count})`);

        if (sweep.true_position === undefined || sweep.true_distance === undefined) {
          check(`A/${resourceType}: tool also reports Not found, matching the independent sweep finding none in range`, tool.error === "Not found", JSON.stringify(tool));
          continue;
        }

        check(
          `A/${resourceType}: tool's distance equals the independent sweep's true minimum`,
          typeof tool.distance === "number" && Math.abs(tool.distance - sweep.true_distance) < EPS,
          `tool=${tool.distance} truth=${sweep.true_distance}`
        );
        check(
          `A/${resourceType}: tool's position is the independent sweep's actual nearest entity`,
          !!tool.position && Math.abs(tool.position.x - sweep.true_position.x) < EPS && Math.abs(tool.position.y - sweep.true_position.y) < EPS,
          `tool=${JSON.stringify(tool.position)} truth=${JSON.stringify(sweep.true_position)}`
        );

        const oldWasWrong = sweep.old_distance !== undefined && Math.abs(sweep.old_distance - sweep.true_distance) > EPS;
        if (oldWasWrong) {
          discriminatingTypes++;
          console.log(`  >>> DISCRIMINATING: the pre-0.17.0 algorithm returned ${sweep.old_distance!.toFixed(2)} where the truth is ${sweep.true_distance.toFixed(2)} (off by ${(sweep.old_distance! - sweep.true_distance).toFixed(2)} tiles)`);
        } else {
          console.log("  >>> not discriminating at this position (the old truncation happened to be harmless here)");
        }
      }

      check(
        "A: at least one resource type is one the OLD limited scan got wrong, so this run actually exercises the fix rather than passing vacuously",
        discriminatingTypes > 0,
        `${discriminatingTypes} of ${RESOURCE_TYPES.length} resource types discriminate at this position`
      );
    });

    // -----------------------------------------------------------
    // Section B: exact, unfloored coordinates
    // -----------------------------------------------------------
    await runSection("B", "resource_nearest returns the entity's exact position and a real distance", async () => {
      const pos = await companionPosition(mcp, NEAREST_ID);
      const tool = await callTool(mcp.client, "resource_nearest", { companionId: NEAREST_ID, resourceType: "iron-ore" });
      console.log(`B: companion at ${JSON.stringify(pos)}, tool ->`, JSON.stringify(tool));

      check(
        "B1: returned position is NOT integer-valued - ore sits at tile centres, so the old math.floor is gone",
        !Number.isInteger(tool.position.x) || !Number.isInteger(tool.position.y),
        JSON.stringify(tool.position)
      );

      // The reported point must be a real resource entity, not an approximation of one.
      const hitRaw = await silent(
        rcon,
        `
          local s = game.players[1].surface
          local es = s.find_entities_filtered{type="resource", position={x=${tool.position.x}, y=${tool.position.y}}, radius=0.1}
          if #es == 0 then rcon.print(helpers.table_to_json({hit = false})); return end
          rcon.print(helpers.table_to_json({hit = true, name = es[1].name, x = es[1].position.x, y = es[1].position.y}))
        `
      );
      const hit = JSON.parse(hitRaw);
      check(
        "B2: an actual iron-ore entity sits exactly at the returned position (within 0.1 tiles)",
        hit.hit === true && hit.name === "iron-ore",
        `${hitRaw} for reported position ${JSON.stringify(tool.position)}`
      );

      const computed = dist(pos, tool.position);
      check(
        "B3: reported distance is the real euclidean distance to that entity, not a floored one",
        Math.abs(tool.distance - computed) < EPS,
        `reported=${tool.distance} computed=${computed}`
      );

      // Quantify what the old flooring cost: the displacement it introduced, against the 2.7-tile
      // engine resource_reach_distance the caller has to spend it out of.
      const flooredPos = { x: Math.floor(tool.position.x), y: Math.floor(tool.position.y) };
      const flooringError = dist(flooredPos, tool.position);
      console.log(`B: pre-0.17.0 would have reported ${JSON.stringify(flooredPos)} - ${flooringError.toFixed(3)} tiles off the real entity, out of a 2.7-tile resource_reach_distance budget`);
      check(
        "B4: the old flooring was a real error, not a rounding nicety (>= 0.5 tiles of displacement)",
        flooringError >= 0.5,
        `floored=${JSON.stringify(flooredPos)} exact=${JSON.stringify(tool.position)} error=${flooringError.toFixed(3)} tiles`
      );
    });

    // -----------------------------------------------------------
    // Section C: constructed arena - deterministic min-picking
    // -----------------------------------------------------------
    await runSection("C", "constructed arena: the 3-tile ore wins over 7-tile and 20-tile decoys", async () => {
      const spot = await findSafeOreArenaSpot(rcon, ARENA_ORIGIN);
      console.log("C: arena spot ->", JSON.stringify(spot));
      check("C setup: found an arena spot clear of spawners/turrets/worms AND of any pre-existing resource", spot.found === true, JSON.stringify(spot));
      if (!spot.found) throw new Error(`No safe ore-arena spot found (${JSON.stringify(spot)}) - section C cannot run without a controlled arena.`);
      arenaAnchor = { x: spot.x!, y: spot.y! };

      const posBefore = await companionPosition(mcp, NEAREST_ID);
      const tp = await teleportCompanion(rcon, posBefore.x, posBefore.y, arenaAnchor.x, arenaAnchor.y);
      check("C setup: companion teleported to the arena anchor", tp.teleported === true, JSON.stringify(tp));

      const anchor = arenaAnchor;
      const plan: Array<{ label: string; offset: { dx: number; dy: number } }> = [
        { label: "NEAR", offset: ORE_NEAR_OFFSET },
        { label: "MID", offset: ORE_MID_OFFSET },
        { label: "FAR", offset: ORE_FAR_OFFSET },
      ];
      const planted: Record<string, { x: number; y: number }> = {};
      for (const p of plan) {
        const tile = await placeOreTile(rcon, { x: anchor.x + p.offset.dx, y: anchor.y + p.offset.dy }, ARENA_ORE_AMOUNT);
        check(`C setup: planted ${p.label} ore tile`, tile.created === true, JSON.stringify(tile));
        if (!tile.created) throw new Error(`Failed to plant ${p.label} ore tile - section C cannot run.`);
        const pos = { x: tile.x!, y: tile.y! };
        plantedOrePositions.push(pos); // recorded immediately so teardown finds it even if a later step throws
        planted[p.label] = pos;
      }

      const posNow = await companionPosition(mcp, NEAREST_ID);
      const dNear = dist(posNow, planted.NEAR!);
      const dMid = dist(posNow, planted.MID!);
      const dFar = dist(posNow, planted.FAR!);
      console.log(`C: companion at ${JSON.stringify(posNow)}; planted distances NEAR=${dNear.toFixed(2)} MID=${dMid.toFixed(2)} FAR=${dFar.toFixed(2)}`);
      check(
        "C setup: the three planted tiles really are ordered NEAR < MID < FAR from where the companion stands",
        dNear < dMid && dMid < dFar,
        `NEAR=${dNear.toFixed(2)} MID=${dMid.toFixed(2)} FAR=${dFar.toFixed(2)}`
      );

      const tool = await callTool(mcp.client, "resource_nearest", { companionId: NEAREST_ID, resourceType: "iron-ore" });
      console.log("C: resource_nearest ->", JSON.stringify(tool));
      check(
        "C1: resource_nearest returns the NEAR tile, not MID (both sit inside the first 8-tile search ring, so this is min-picking within a ring, not just early-stopping)",
        !!tool.position && Math.abs(tool.position.x - planted.NEAR!.x) < EPS && Math.abs(tool.position.y - planted.NEAR!.y) < EPS,
        `tool=${JSON.stringify(tool.position)} NEAR=${JSON.stringify(planted.NEAR)} MID=${JSON.stringify(planted.MID)} FAR=${JSON.stringify(planted.FAR)}`
      );
      check(
        "C2: reported distance matches the NEAR tile's real distance",
        Math.abs(tool.distance - dNear) < EPS,
        `reported=${tool.distance} computed=${dNear}`
      );
    });

    // -----------------------------------------------------------
    // Section D: world_nearest got the same fix
    // -----------------------------------------------------------
    await runSection("D", "world_nearest agrees with an independent unlimited sweep (tree and water branches)", async () => {
      const posTree = await companionPosition(mcp, NEAREST_ID);
      const treeTool = await callTool(mcp.client, "world_nearest", { companionId: NEAREST_ID, entityName: "wood" });
      const treeSweep = await sweepEntities(rcon, posTree, "type", "tree");
      console.log(`\nD/tree: companion at ${JSON.stringify(posTree)}`);
      console.log(`  tool  -> distance=${treeTool.distance} position=${JSON.stringify(treeTool.position)}`);
      console.log(`  truth -> distance=${treeSweep.true_distance} position=${JSON.stringify(treeSweep.true_position)} (${treeSweep.in_range_count} in range of ${treeSweep.total_count})`);
      console.log(`  old   -> distance=${treeSweep.old_distance} (sampled ${treeSweep.old_count})`);

      if (treeSweep.true_distance === undefined) {
        check("D1: tool reports Not found for trees, matching the independent sweep", treeTool.error === "Not found", JSON.stringify(treeTool));
      } else {
        check(
          "D1: world_nearest(wood) distance equals the independent sweep's true minimum",
          typeof treeTool.distance === "number" && Math.abs(treeTool.distance - treeSweep.true_distance) < EPS,
          `tool=${treeTool.distance} truth=${treeSweep.true_distance}`
        );
        check(
          "D2: world_nearest(wood) position is the independent sweep's actual nearest tree",
          !!treeTool.position && Math.abs(treeTool.position.x - treeSweep.true_position!.x) < EPS && Math.abs(treeTool.position.y - treeSweep.true_position!.y) < EPS,
          `tool=${JSON.stringify(treeTool.position)} truth=${JSON.stringify(treeSweep.true_position)}`
        );
      }

      const posWater = await companionPosition(mcp, NEAREST_ID);
      const waterTool = await callTool(mcp.client, "world_nearest", { companionId: NEAREST_ID, entityName: "water" });
      const waterSweep = await sweepTiles(rcon, posWater, ["water", "deepwater"]);
      console.log(`\nD/water: companion at ${JSON.stringify(posWater)}`);
      console.log(`  tool  -> distance=${waterTool.distance} position=${JSON.stringify(waterTool.position)}`);
      console.log(`  truth -> distance=${waterSweep.true_distance} position=${JSON.stringify(waterSweep.true_position)} (${waterSweep.in_range_count} in range of ${waterSweep.total_count})`);
      console.log(`  old   -> distance=${waterSweep.old_distance} (sampled ${waterSweep.old_count})`);

      if (waterSweep.true_distance === undefined) {
        check("D3: tool reports Not found for water, matching the independent sweep finding none in range", waterTool.error === "Not found", JSON.stringify(waterTool));
      } else {
        check(
          "D3: world_nearest(water) distance equals the independent sweep's true minimum",
          typeof waterTool.distance === "number" && Math.abs(waterTool.distance - waterSweep.true_distance) < EPS,
          `tool=${waterTool.distance} truth=${waterSweep.true_distance}`
        );
        check(
          "D4: world_nearest(water) position is the independent sweep's actual nearest water tile",
          !!waterTool.position && Math.abs(waterTool.position.x - waterSweep.true_position!.x) < EPS && Math.abs(waterTool.position.y - waterSweep.true_position!.y) < EPS,
          `tool=${JSON.stringify(waterTool.position)} truth=${JSON.stringify(waterSweep.true_position)}`
        );
      }
    });

    // -----------------------------------------------------------
    // Section E: regressions
    // -----------------------------------------------------------
    await runSection("E", "regressions: absent resource reports Not found, and mine_until still consumes the new coordinates", async () => {
      const posE = await companionPosition(mcp, NEAREST_ID);
      const absent = await callTool(mcp.client, "resource_nearest", { companionId: NEAREST_ID, resourceType: "uranium-ore" });
      const absentSweep = await sweepEntities(rcon, posE, "name", "uranium-ore");
      console.log("E1: resource_nearest(uranium-ore) ->", JSON.stringify(absent), " sweep ->", JSON.stringify(absentSweep));
      if (absentSweep.true_distance === undefined) {
        check(
          "E1: an exhausted expanding search reports {error:'Not found'} rather than hanging or throwing",
          absent.error === "Not found",
          JSON.stringify(absent)
        );
      } else {
        check(
          "E1: uranium-ore genuinely exists in range here, and the tool agrees with the sweep instead of reporting Not found",
          typeof absent.distance === "number" && Math.abs(absent.distance - absentSweep.true_distance) < EPS,
          `tool=${JSON.stringify(absent)} truth=${absentSweep.true_distance}`
        );
      }

      // mine-until is resource_nearest's main consumer and now receives fractional coordinates
      // where it used to get integers - it passes them straight into /fac_move_to and
      // /fac_resource_mine, so a parsing regression there would show up as a failed run here.
      if (!arenaAnchor) {
        check("E2: arena available for the mine_until regression", false, "section C did not establish an arena, so this check cannot run");
        return;
      }
      await callToolRaw(mcp.client, "companion_stop_all", { companionId: NEAREST_ID });
      const nearTile = plantedOrePositions[0]!;
      const posBeforeE = await companionPosition(mcp, NEAREST_ID);
      const tpE = await teleportCompanion(rcon, posBeforeE.x, posBeforeE.y, nearTile.x, nearTile.y);
      check("E setup: companion teleported onto the planted NEAR ore tile", tpE.teleported === true, JSON.stringify(tpE));

      const t0 = Date.now();
      const startE = await callToolRaw(mcp.client, "resource_mine_until", { companionId: NEAREST_ID, resource: "iron", amount: 5 });
      console.log("E2: resource_mine_until (start) ->", startE);
      const { status: statusE, result: resultE, outcome: outcomeE } = await pollUntilSkillDone(mcp, NEAREST_ID);
      const elapsedE = Date.now() - t0;
      console.log(`E2: skill outcome=${outcomeE}, elapsed=${elapsedE}ms, status ->`, JSON.stringify(statusE));
      console.log("E2: parsed SKILL_RESULT ->", JSON.stringify(resultE));

      check("E2: mine_until skill completed within the poll budget", outcomeE === "done", `outcome=${outcomeE} elapsed=${elapsedE}ms`);
      check(
        "E3: mine_until succeeded against fractional resource_nearest coordinates (the consumer contract survived the un-flooring)",
        resultE?.success === true && (resultE?.mined ?? 0) >= 5,
        JSON.stringify(resultE)
      );
      check("E4: mine_until's process exited 0", statusE?.lastSkillResult?.exitCode === 0, JSON.stringify(statusE?.lastSkillResult));
    });
  } finally {
    // -----------------------------------------------------------
    // Teardown - by exact recorded position, then independently verified
    // -----------------------------------------------------------
    console.log("\n=== Teardown ===");
    try {
      const posRes = await callTool(mcp.client, "companion_position", { companionId: NEAREST_ID });
      const disappear = await callTool(mcp.client, "companion_disappear", { companionId: NEAREST_ID });
      console.log("Teardown: companion_disappear ->", JSON.stringify(disappear));
      const dropped = asArray<{ name: string; count: number }>(disappear?.dropped);
      if (dropped.length > 0 && posRes?.position) {
        const destroyed = await destroyGroundResidue(rcon, posRes.position.x, posRes.position.y);
        console.log(`Teardown: destroyed ${destroyed} ground residue entities (${JSON.stringify(dropped)})`);
      }
    } catch (e) {
      console.log("Teardown: companion cleanup failed -", e instanceof Error ? e.message : String(e));
    }

    try {
      const destroyed = await destroyOreTiles(rcon, plantedOrePositions);
      console.log(`Teardown: destroyed ${destroyed.destroyed} of ${plantedOrePositions.length} planted ore tiles (already-mined-out tiles are legitimately gone)`);
      if (arenaAnchor) {
        // A teardown that silently no-ops logs nothing, so prove the world is clean rather than
        // trusting the destroy call's own report (this exact trap littered t031's arenas).
        const residual = await countResourcesNear(rcon, arenaAnchor, ORE_CLEAR_RADIUS);
        check("Teardown: zero resource entities remain near the arena anchor (the arena was verified resource-free before planting)", residual === 0, `${residual} resource entities remain within ${ORE_CLEAR_RADIUS} tiles of ${JSON.stringify(arenaAnchor)}`);
      }
    } catch (e) {
      console.log("Teardown: ore cleanup failed -", e instanceof Error ? e.message : String(e));
    }

    await rcon.close();
    await mcp.close();
  }

  process.exit(summary());
}

main();
