// Live smoke test for T-026: "companion arming from the player's inventory".
//
// Contract under test (companion.lua:44, queues.lua:605-607, init.lua:214 M.arm_from):
//   - companion_spawn transfers a gun + matching ammo OUT of game.players[1]'s MAIN
//     inventory into the fresh companion. Nothing is ever conjured. No suitable pair ->
//     the companion spawns unarmed ({armed:false, arm_reason:"..."}) - a success, not an
//     error. The player's EQUIPPED gun/ammo slots are never touched.
//   - action_attack_start (and combat_until, which drives it) rejects an unarmed companion
//     with {error:"No weapon equipped"} / {error:"No ammo"} instead of starting a queue.
//   - Ammo compatibility is matched by ammo_category (init.lua:193-199, 201-209), NOT by
//     LuaInventory:can_insert - live-verified this session that can_insert{name="rocket"}
//     returns true against an inventory holding only a submachine-gun, so a naive
//     can_insert-based picker would load a rocket-launcher with bullets.
//
// Six checks, run against the live game + MCP server, in this order (later checks reuse
// companions/state from earlier ones where noted):
//   1. Negative control - empty-handed player -> armed:false + arm_reason, companion's own
//      gun/ammo slots empty by side channel.
//   2. The player's EQUIPPED loadout (pistol + firearm-magazine) is untouched by that spawn -
//      catches an arm_from that raids the wrong inventory.
//   3. Positive case - gun+ammo staged in the player's MAIN inventory -> armed:true with the
//      right weapon/ammo/ammo_count, verified by side channel, and the player's main
//      inventory count drops by exactly what the companion gained (transfer, not dupe).
//   4. Ammo-compatibility regression - a mismatched rocket-launcher + firearm-magazine pair
//      must never result in a rocket-launcher loaded with bullets.
//   5. The Done-when itself - the armed companion from check 3 is teleported into a controlled
//      arena (clear of spawners/turrets/worms) with exactly one spawned small-biter at a known
//      distance, and completes combat_until(maxKills:1), with the companion's own inventory
//      never written by the test in between. (Previously hunted the live map for a naturally
//      occurring lone biter - the root cause of this suite's flakiness; see FIX 3 below.)
//   6. Unarmed hard-fail - action_attack_start on an unarmed companion returns the guard
//      error directly, and combat_until on it terminates with outcome "unarmed" in well
//      under the 30-attempt worst case, instead of burning all attempts walking nowhere.
//
// Run directly against a live Factorio game + MCP server:
//   bun run scripts/smoke/t026-companion-arming.ts
import { readFileSync } from "node:fs";
import { connectMCP, connectRCON, callTool, callToolRaw, check, summary, silent } from "./lib";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// helpers.table_to_json serializes an EMPTY Lua table as a JSON object ({}), not an array ([]) -
// every ids/list snapshot below must run through this before .length/.filter/.includes are used.
function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

const SKILL_POLL_BUDGET_MS = 120000; // combat-until's own walk (30s) + attack (60s) timeouts, x margin
const SKILL_POLL_INTERVAL_MS = 1500;
// companions spawn id*2 tiles apart on the x axis (companion.lua:37) - tight enough to
// disambiguate a same-tick neighbor spawn, loose enough for spawn-position float rounding.
const ENTITY_LOOKUP_RADIUS = 1.5;
// Wall-clock proxy for "terminates quickly rather than burning all 30 attempts" (Check 6).
const UNARMED_FAST_FAIL_BUDGET_MS = 30000;

// FIX 3: controlled combat arena, replacing the old natural-cluster hunt (findLoneCandidates).
// That hunt was the root of this suite's flakiness - it could find 0 candidates live, or hand
// back a target that turned out to have unexpected neighbours once engaged. Spawning entities
// and teleporting the companion is explicitly fine in test-harness code (cleared with the task
// owner) - only the MOD's own gameplay behaviour is off-limits for conjuring/teleporting, not
// what this harness may do to stage a scenario.
const ARENA_SAFETY_RADIUS = 30; // min distance from any enemy spawner/turret/worm (worms are prototype type="turret") for an arena spot to qualify
const ARENA_ENGAGE_DISTANCE = 15; // biter spawn distance from the companion - inside combat_until's own 50-tile scan
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
];

// Distinct, high companion ids so this test never collides with t021's companion 1.
const NEG_CONTROL_ID = 21;
const POSITIVE_ID = 22;
const MISMATCH_ID = 23;
const UNARMED_HARDFAIL_ID = 24;

interface SkillResult {
  skill: string;
  companionId: number;
  kills: number;
  target: number;
  outcome: string;
  success: boolean;
  uncausedDeaths?: number;
  unarmedReason?: string;
}

/** Lua snippet prefix that finds the (single) non-player character near (x, y) and binds it to
 *  __target. /silent-command has no access to storage.companions, so this is the only way to
 *  resolve "the entity for companion id N" from a side channel - reuse it right after reading
 *  that companion's position via the MCP tool (which DOES resolve storage), before it could
 *  plausibly have wandered into another companion's lookup radius. */
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

/** Reads the trailing SKILL_RESULT line out of a combat-until log file. */
function parseSkillResultLog(logPath: string): SkillResult | null {
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

async function pollUntilSkillDone(mcp: { client: any }, companionId: number): Promise<{ status: any; result: SkillResult | null }> {
  const start = Date.now();
  while (Date.now() - start < SKILL_POLL_BUDGET_MS) {
    const status = await callTool(mcp.client, "companion_status", { companionId });
    if (status.skill?.running !== true && status.lastSkillResult) {
      const result = parseSkillResultLog(status.lastSkillResult.logPath);
      return { status, result };
    }
    console.log("  ...skill still running, elapsed", Date.now() - start, "ms");
    await sleep(SKILL_POLL_INTERVAL_MS);
  }
  const status = await callTool(mcp.client, "companion_status", { companionId });
  return { status, result: status.lastSkillResult ? parseSkillResultLog(status.lastSkillResult.logPath) : null };
}

interface ArenaSpot {
  found: boolean;
  x?: number;
  y?: number;
}

/** FIX 3: finds a staging point clear of enemy spawners/turrets/worms (worms are prototype
 *  type="turret" too, so the same filter catches them) within ARENA_SAFETY_RADIUS. Tries
 *  candidate offsets from `ref` outward - mirrors the distance-filter idea from the old
 *  natural-cluster hunt, but checks the CANDIDATE POINT's surroundings directly instead of
 *  filtering already-existing enemy units. `found` is always present (never nil-omitted). */
async function findSafeArenaSpot(rcon: { send: (cmd: string) => Promise<string> }, ref: { x: number; y: number }): Promise<ArenaSpot> {
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
        local nearby = surface.find_entities_filtered{type={"unit-spawner", "turret"}, force="enemy", position={x=px, y=py}, radius=${ARENA_SAFETY_RADIUS}}
        if #nearby == 0 then
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

/** Teleports the companion currently near (curX, curY) to (destX, destY). Test-harness-only -
 *  the mod's own gameplay code never teleports a companion. */
async function teleportCompanionToArena(
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
      local dest = __target.surface.find_non_colliding_position("character", {x=${destX}, y=${destY}}, 10, 0.5)
      local teleported = false
      if dest then teleported = __target.teleport(dest) end
      rcon.print(helpers.table_to_json({teleported = teleported}))
    `
  );
  return JSON.parse(raw);
}

/** Spawns small-biters (force "enemy") at the given positions via create_entity, nudged onto the
 *  nearest non-colliding tile within 3 tiles so a tight cluster's fixed offsets don't fail to
 *  place. Returns the real spawned unit_numbers (ground truth + teardown target - never a count
 *  guess), via asArray since an all-failed spawn serializes as {} not []. */
async function spawnBiters(rcon: { send: (cmd: string) => Promise<string> }, positions: Array<{ x: number; y: number }>): Promise<number[]> {
  const posLua = positions.map((p) => `{x=${p.x}, y=${p.y}}`).join(", ");
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local positions = {${posLua}}
      local ids = {}
      for _, p in ipairs(positions) do
        local spot = surface.find_non_colliding_position("small-biter", p, 3, 0.5) or p
        local e = surface.create_entity{name="small-biter", position=spot, force="enemy"}
        if e and e.valid then ids[#ids + 1] = e.unit_number end
      end
      rcon.print(helpers.table_to_json({ids = ids, count = #ids}))
    `
  );
  return asArray<number>(JSON.parse(raw).ids);
}

/** Destroys any still-alive spawned units by unit_number, and nothing else - so teardown never
 *  touches a pre-existing map enemy. A no-op for ids already dead (find_entities_filtered only
 *  returns valid/alive entities), so it's safe to call again as a final safety net. */
async function destroySpawnedUnits(rcon: { send: (cmd: string) => Promise<string> }, ids: number[]): Promise<{ destroyed: number }> {
  if (ids.length === 0) return { destroyed: 0 };
  const idSetLua = ids.map((id) => `[${id}] = true`).join(", ");
  const raw = await silent(
    rcon,
    `
      local surface = game.players[1].surface
      local target_ids = {${idSetLua}}
      local destroyed = 0
      for _, u in ipairs(surface.find_entities_filtered{type="unit", force="enemy"}) do
        if u.valid and target_ids[u.unit_number] then
          u.destroy()
          destroyed = destroyed + 1
        end
      end
      rcon.print(helpers.table_to_json({destroyed = destroyed}))
    `
  );
  return JSON.parse(raw);
}

/** Arranges `count` positions around `center` on a circle of radius `spread` tiles (a single
 *  point for count 1). Used to place spawned biters at a known, controlled density. */
function clusterPositions(center: { x: number; y: number }, count: number, spread: number): Array<{ x: number; y: number }> {
  if (count <= 1) return [center];
  const positions: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    positions.push({ x: center.x + spread * Math.cos(angle), y: center.y + spread * Math.sin(angle) });
  }
  return positions;
}

/** Reads a companion's gun/ammo slot 1 contents by side channel, given its current position.
 *  FIX 2: every field is ALWAYS present with an explicit "empty" value (0 / "") rather than a
 *  Lua `... or nil` expression - helpers.table_to_json drops nil-valued keys entirely, which
 *  previously made "the slot is empty" indistinguishable on the JS side from "the field was
 *  never read" (both surfaced as `undefined`, so `=== null` assertions could never pass). */
async function readCompanionGunAmmo(
  rcon: { send: (cmd: string) => Promise<string> },
  x: number,
  y: number
): Promise<{
  gun_slots_filled: number;
  ammo_slots_filled: number;
  gun1_name: string;
  ammo1_name: string;
  ammo1_count: number;
  selected_gun_index: number;
  error?: string;
}> {
  const raw = await silent(
    rcon,
    findEntityNearLua(x, y) +
      `
      local guns = __target.get_inventory(defines.inventory.character_guns)
      local ammoInv = __target.get_inventory(defines.inventory.character_ammo)
      local gun1_present = guns[1] and guns[1].valid_for_read
      local ammo1_present = ammoInv[1] and ammoInv[1].valid_for_read
      rcon.print(helpers.table_to_json({
        gun_slots_filled = gun1_present and 1 or 0,
        ammo_slots_filled = ammo1_present and 1 or 0,
        gun1_name = gun1_present and guns[1].name or "",
        ammo1_name = ammo1_present and ammoInv[1].name or "",
        ammo1_count = ammo1_present and ammoInv[1].count or 0,
        selected_gun_index = __target.selected_gun_index or -1
      }))
    `
  );
  return JSON.parse(raw);
}

/** Reads the PLAYER's equipped gun/ammo slot 1 (never touched by arm_from - it only reads/writes
 *  the MAIN inventory). Same explicit-value shape as readCompanionGunAmmo (FIX 2 sweep). */
async function readPlayerEquippedLoadout(
  rcon: { send: (cmd: string) => Promise<string> }
): Promise<{ gun1_name: string; ammo1_name: string; ammo1_count: number }> {
  const raw = await silent(
    rcon,
    `
      local p = game.players[1]
      local guns = p.character.get_inventory(defines.inventory.character_guns)
      local ammoInv = p.character.get_inventory(defines.inventory.character_ammo)
      local gun1_present = guns[1] and guns[1].valid_for_read
      local ammo1_present = ammoInv[1] and ammoInv[1].valid_for_read
      rcon.print(helpers.table_to_json({
        gun1_name = gun1_present and guns[1].name or "",
        ammo1_name = ammo1_present and ammoInv[1].name or "",
        ammo1_count = ammo1_present and ammoInv[1].count or 0
      }))
    `
  );
  return JSON.parse(raw);
}

/** Reads item counts from the PLAYER's MAIN inventory (the pool arm_from draws from). */
async function readPlayerMainInvCounts(
  rcon: { send: (cmd: string) => Promise<string> },
  items: Array<[itemName: string, key: string]>
): Promise<Record<string, number>> {
  const fields = items.map(([name, key]) => `${key} = inv.get_item_count("${name}")`).join(", ");
  const raw = await silent(rcon, `local inv = game.players[1].get_main_inventory(); rcon.print(helpers.table_to_json({${fields}}))`);
  return JSON.parse(raw);
}

/** Destroys any item-on-ground entities within a small radius of (x, y). Used right after a
 *  companion_disappear spills gun/ammo to the ground (companion.lua's spill_equipment) - that
 *  residue belongs to a companion this harness is removing (either stale, from a previous run, or
 *  its own at teardown), not to the player, so it's destroyed outright rather than reinserted -
 *  reinserting it would silently violate this suite's own "player's main inventory has no gun"
 *  setup assertions (Check1/Check3/Check6). */
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
 *  suite, or (in teardown) this run's own. fac_companion_disappear (companion.lua:53-74) clears
 *  storage.companions[id] unconditionally, so a subsequent companion_spawn takes the fresh-spawn
 *  branch ({spawned:true, ...}) rather than the {status:"exists"} no-op that skips spawn-time
 *  arming entirely - that no-op, hitting stale companions 21-24 from a prior run, was the root
 *  cause of this suite scoring 20/36 live. A no-op if no companion is present at `id`. */
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
  const spawnedIds: number[] = [];
  // Check5/Check6's arena-spawned biter unit_number(s) - tracked at this scope so the top-level
  // cleanup can tear down a survivor even if something threw between spawning and their own
  // inline teardown calls.
  let check5SpawnedIds: number[] = [];
  let check6SpawnedIds: number[] = [];

  // Accumulates the REAL insert() return values from every staging call this test makes, so final
  // cleanup removes exactly what was staged - never a flat guess that could eat a pre-existing
  // item the player already owned (same bug class as t021-combat-kills.ts's teardown asymmetry).
  const stagedTotals: Record<string, number> = { "submachine-gun": 0, "firearm-magazine": 0, "rocket-launcher": 0 };

  try {
    // -----------------------------------------------------------
    // Check 1 & 2: negative control - empty-handed player
    // -----------------------------------------------------------
    console.log("\n=== Check 1&2: negative control - empty-handed player ===");
    const preMain = await readPlayerMainInvCounts(rcon, [
      ["submachine-gun", "smg"],
      ["rocket-launcher", "rocket_launcher"],
    ]);
    console.log("Player main inventory (pre negative-control) ->", JSON.stringify(preMain));
    check(
      "Check1 setup: player's main inventory has no gun before the negative-control spawn",
      preMain.smg === 0 && preMain.rocket_launcher === 0,
      JSON.stringify(preMain)
    );

    const preEquipped = await readPlayerEquippedLoadout(rcon);
    console.log("Player equipped loadout (pre negative-control) ->", JSON.stringify(preEquipped));
    check(
      "Check1 setup: player has pistol equipped in gun slot 1 (documented live baseline)",
      preEquipped.gun1_name === "pistol",
      JSON.stringify(preEquipped)
    );
    check(
      "Check1 setup: player has firearm-magazine equipped in ammo slot 1",
      preEquipped.ammo1_name === "firearm-magazine" && preEquipped.ammo1_count > 0,
      JSON.stringify(preEquipped)
    );

    await clearStaleCompanion(mcp, rcon, NEG_CONTROL_ID);
    const negSpawn = await callTool(mcp.client, "companion_spawn", { companionId: NEG_CONTROL_ID });
    spawnedIds.push(NEG_CONTROL_ID);
    console.log("companion_spawn (negative control) ->", JSON.stringify(negSpawn));
    check(
      "Check1 setup: companion spawned genuinely fresh (spawned:true, not status:'exists')",
      negSpawn.spawned === true,
      JSON.stringify(negSpawn)
    );
    if (negSpawn.spawned !== true) {
      throw new Error(
        `Companion ${NEG_CONTROL_ID} did not spawn fresh (${JSON.stringify(negSpawn)}) - stale-companion cleanup failed to clear it, so ` +
          "this spawn skipped spawn-time arming and every downstream Check1/Check2 assertion would be meaningless. Aborting immediately."
      );
    }
    check("Check1: empty-handed player yields armed:false", negSpawn.armed === false, JSON.stringify(negSpawn));
    check(
      "Check1: armed:false carries a non-empty arm_reason",
      typeof negSpawn.arm_reason === "string" && negSpawn.arm_reason.length > 0,
      JSON.stringify(negSpawn)
    );

    const negPos = await callTool(mcp.client, "companion_position", { companionId: NEG_CONTROL_ID });
    const negGunAmmo = await readCompanionGunAmmo(rcon, negPos.position.x, negPos.position.y);
    console.log("Companion gun/ammo slots (negative control) ->", JSON.stringify(negGunAmmo));
    check("Check1: unarmed companion's gun slot is empty by side channel", negGunAmmo.gun_slots_filled === 0, JSON.stringify(negGunAmmo));
    check("Check1: unarmed companion's ammo slot is empty by side channel", negGunAmmo.ammo_slots_filled === 0, JSON.stringify(negGunAmmo));

    const postEquipped = await readPlayerEquippedLoadout(rcon);
    console.log("Player equipped loadout (post negative-control spawn) ->", JSON.stringify(postEquipped));
    check(
      "Check2: player still has pistol equipped in gun slot 1 after spawn (arm_from didn't raid the equipped slots)",
      postEquipped.gun1_name === "pistol",
      JSON.stringify(postEquipped)
    );
    check(
      "Check2: player still has firearm-magazine equipped in ammo slot 1, same count as before",
      postEquipped.ammo1_name === "firearm-magazine" && postEquipped.ammo1_count === preEquipped.ammo1_count,
      JSON.stringify({ before: preEquipped, after: postEquipped })
    );

    // -----------------------------------------------------------
    // Check 3: positive case - gun+ammo staged in the player's MAIN inventory
    // -----------------------------------------------------------
    console.log("\n=== Check 3: positive case - gun+ammo staged in the player's main inventory ===");
    const preStageMain = await readPlayerMainInvCounts(rcon, [
      ["submachine-gun", "smg"],
      ["firearm-magazine", "mag"],
    ]);
    check("Check3 setup: player's main inventory had no submachine-gun before staging", preStageMain.smg === 0, JSON.stringify(preStageMain));

    const insertRaw = await silent(
      rcon,
      `
        local inv = game.players[1].get_main_inventory()
        local smg_inserted = inv.insert{name="submachine-gun", count=1}
        local mag_inserted = inv.insert{name="firearm-magazine", count=50}
        rcon.print(helpers.table_to_json({smg_inserted = smg_inserted, mag_inserted = mag_inserted}))
      `
    );
    console.log("Staged gun+ammo into player's main inventory ->", insertRaw);
    const staged = JSON.parse(insertRaw);
    check("Check3 setup: staged 1x submachine-gun into player's main inventory", staged.smg_inserted === 1, insertRaw);
    check("Check3 setup: staged 50x firearm-magazine into player's main inventory", staged.mag_inserted === 50, insertRaw);
    stagedTotals["submachine-gun"] += staged.smg_inserted;
    stagedTotals["firearm-magazine"] += staged.mag_inserted;

    const preSpawnMain = await readPlayerMainInvCounts(rcon, [
      ["submachine-gun", "smg"],
      ["firearm-magazine", "mag"],
    ]);
    console.log("Player main inventory just before positive-case spawn ->", JSON.stringify(preSpawnMain));

    await clearStaleCompanion(mcp, rcon, POSITIVE_ID);
    const posSpawn = await callTool(mcp.client, "companion_spawn", { companionId: POSITIVE_ID });
    spawnedIds.push(POSITIVE_ID);
    console.log("companion_spawn (positive case) ->", JSON.stringify(posSpawn));
    check(
      "Check3 setup: companion spawned genuinely fresh (spawned:true, not status:'exists')",
      posSpawn.spawned === true,
      JSON.stringify(posSpawn)
    );
    if (posSpawn.spawned !== true) {
      throw new Error(
        `Companion ${POSITIVE_ID} did not spawn fresh (${JSON.stringify(posSpawn)}) - stale-companion cleanup failed to clear it, so this ` +
          "spawn never got a chance at spawn-time arming and every downstream Check3/Check5 assertion would be meaningless. Aborting immediately."
      );
    }
    check("Check3: positive case returns armed:true", posSpawn.armed === true, JSON.stringify(posSpawn));
    check("Check3: positive case reports weapon:'submachine-gun'", posSpawn.weapon === "submachine-gun", JSON.stringify(posSpawn));
    check("Check3: positive case reports ammo:'firearm-magazine'", posSpawn.ammo === "firearm-magazine", JSON.stringify(posSpawn));
    check(
      "Check3: positive case reports ammo_count > 0",
      typeof posSpawn.ammo_count === "number" && posSpawn.ammo_count > 0,
      JSON.stringify(posSpawn)
    );

    const posPos = await callTool(mcp.client, "companion_position", { companionId: POSITIVE_ID });
    const posGunAmmo = await readCompanionGunAmmo(rcon, posPos.position.x, posPos.position.y);
    console.log("Companion gun/ammo slots (positive case) ->", JSON.stringify(posGunAmmo));
    check("Check3: gun is in character_guns slot 1 by side channel", posGunAmmo.gun1_name === "submachine-gun", JSON.stringify(posGunAmmo));
    check("Check3: ammo is in character_ammo slot 1 by side channel", posGunAmmo.ammo1_name === "firearm-magazine", JSON.stringify(posGunAmmo));
    check("Check3: selected_gun_index points at the armed gun's slot", posGunAmmo.selected_gun_index === 1, JSON.stringify(posGunAmmo));

    const postSpawnMain = await readPlayerMainInvCounts(rcon, [
      ["submachine-gun", "smg"],
      ["firearm-magazine", "mag"],
    ]);
    console.log("Player main inventory just after positive-case spawn ->", JSON.stringify(postSpawnMain));
    check(
      "Check3 (transfer, not duplication): player's main-inventory submachine-gun count dropped by exactly 1",
      (preSpawnMain.smg ?? 0) - (postSpawnMain.smg ?? 0) === 1,
      JSON.stringify({ before: preSpawnMain, after: postSpawnMain })
    );
    check(
      "Check3 (transfer, not duplication): player's main-inventory firearm-magazine count dropped by exactly the companion's ammo_count",
      (preSpawnMain.mag ?? 0) - (postSpawnMain.mag ?? 0) === (posSpawn.ammo_count ?? -1),
      JSON.stringify({ before: preSpawnMain, after: postSpawnMain, ammo_count: posSpawn.ammo_count })
    );

    // -----------------------------------------------------------
    // Check 4: ammo compatibility is by category, not can_insert
    // -----------------------------------------------------------
    console.log("\n=== Check 4: ammo-compatibility regression - mismatched rocket-launcher + firearm-magazine ===");
    const mismatchInsertRaw = await silent(
      rcon,
      `
        local inv = game.players[1].get_main_inventory()
        local launcher_inserted = inv.insert{name="rocket-launcher", count=1}
        local mag_inserted = inv.insert{name="firearm-magazine", count=50}
        rcon.print(helpers.table_to_json({launcher_inserted = launcher_inserted, mag_inserted = mag_inserted}))
      `
    );
    console.log("Staged mismatched rocket-launcher + firearm-magazine ->", mismatchInsertRaw);
    const mismatchStaged = JSON.parse(mismatchInsertRaw);

    await clearStaleCompanion(mcp, rcon, MISMATCH_ID);
    const mismatchSpawn = await callTool(mcp.client, "companion_spawn", { companionId: MISMATCH_ID });
    spawnedIds.push(MISMATCH_ID);
    console.log("companion_spawn (mismatch) ->", JSON.stringify(mismatchSpawn));
    check(
      "Check4 setup: companion spawned genuinely fresh (spawned:true, not status:'exists')",
      mismatchSpawn.spawned === true,
      JSON.stringify(mismatchSpawn)
    );
    if (mismatchSpawn.spawned !== true) {
      throw new Error(
        `Companion ${MISMATCH_ID} did not spawn fresh (${JSON.stringify(mismatchSpawn)}) - stale-companion cleanup failed to clear it, so ` +
          "this spawn's arming outcome can't be attributed to this check. Aborting immediately."
      );
    }

    if (mismatchSpawn.armed === false) {
      check(
        "Check4: mismatched gun+ammo -> companion stays unarmed with an arm_reason (no gun has genuinely-present matching ammo)",
        typeof mismatchSpawn.arm_reason === "string" && mismatchSpawn.arm_reason.length > 0,
        JSON.stringify(mismatchSpawn)
      );
    } else {
      check(
        "Check4: if armed anyway, the companion did NOT end up with rocket-launcher+firearm-magazine (the can_insert-lies regression)",
        !(mismatchSpawn.weapon === "rocket-launcher" && mismatchSpawn.ammo === "firearm-magazine"),
        JSON.stringify(mismatchSpawn)
      );
    }

    const mismatchPos = await callTool(mcp.client, "companion_position", { companionId: MISMATCH_ID });
    const mismatchGunAmmo = await readCompanionGunAmmo(rcon, mismatchPos.position.x, mismatchPos.position.y);
    console.log("Companion gun/ammo slots (mismatch) ->", JSON.stringify(mismatchGunAmmo));
    check(
      "Check4 DECISIVE: companion is never left with rocket-launcher loaded with firearm-magazine bullets, by side channel",
      !(mismatchGunAmmo.gun1_name === "rocket-launcher" && mismatchGunAmmo.ammo1_name === "firearm-magazine"),
      JSON.stringify(mismatchGunAmmo)
    );

    // Clean these mismatched items back out immediately (whether they ended up transferred to
    // the companion or are still sitting in the player's main inventory). Budget the removal at
    // exactly what staging actually inserted (mismatchStaged) rather than the hardcoded 1/50 the
    // insert also used - if the inventory had been too full to take the full amount, a hardcoded
    // remove would over-remove into whatever the player already owned.
    const mismatchCleanupRaw = await silent(
      rcon,
      findEntityNearLua(mismatchPos.position.x, mismatchPos.position.y) +
        `
        local companion_launcher_removed = __target.get_inventory(defines.inventory.character_guns).remove{name="rocket-launcher", count=${mismatchStaged.launcher_inserted}}
        local companion_ammo_removed = __target.get_inventory(defines.inventory.character_ammo).remove{name="firearm-magazine", count=${mismatchStaged.mag_inserted}}
        local main_inv = game.players[1].get_main_inventory()
        local player_launcher_removed = main_inv.remove{name="rocket-launcher", count=${mismatchStaged.launcher_inserted} - companion_launcher_removed}
        local player_ammo_removed = main_inv.remove{name="firearm-magazine", count=${mismatchStaged.mag_inserted} - companion_ammo_removed}
        rcon.print(helpers.table_to_json({
          companion_launcher_removed = companion_launcher_removed, companion_ammo_removed = companion_ammo_removed,
          player_launcher_removed = player_launcher_removed, player_ammo_removed = player_ammo_removed
        }))
      `
    );
    console.log("Check4 cleanup: removed mismatched gun/ammo ->", mismatchCleanupRaw);

    // -----------------------------------------------------------
    // Check 5: the Done-when itself - armed companion completes combat_until(maxKills:1)
    // FIX 3: controlled arena (teleport + spawn) instead of hunting the live map for a
    // naturally occurring lone biter - see the ARENA_* constants and helpers above.
    // -----------------------------------------------------------
    console.log("\n=== Check 5 (Done-when): armed companion completes combat_until(maxKills:1) [controlled arena] ===");
    const armedPos = await callTool(mcp.client, "companion_position", { companionId: POSITIVE_ID });
    const preInv = await callTool(mcp.client, "companion_inventory", { companionId: POSITIVE_ID });
    console.log("Armed companion's main inventory before combat ->", JSON.stringify(preInv));

    const arenaSpot = await findSafeArenaSpot(rcon, { x: armedPos.position.x, y: armedPos.position.y });
    console.log("Check5: arena spot ->", JSON.stringify(arenaSpot));
    check("Check5 setup: a safe arena spot (clear of spawners/turrets/worms) was found", arenaSpot.found === true, JSON.stringify(arenaSpot));

    let done5Result: SkillResult | null = null;
    let done5Status: any = null;

    if (arenaSpot.found) {
      const teleport = await teleportCompanionToArena(rcon, armedPos.position.x, armedPos.position.y, arenaSpot.x!, arenaSpot.y!);
      console.log("Check5: teleport into arena ->", JSON.stringify(teleport));
      check("Check5 setup: companion teleported into the arena", teleport.teleported === true, JSON.stringify(teleport));

      const targetCenter = { x: arenaSpot.x! + ARENA_ENGAGE_DISTANCE, y: arenaSpot.y! };
      check5SpawnedIds = await spawnBiters(rcon, clusterPositions(targetCenter, 1, 0));
      console.log("Check5: spawned biter(s) ->", JSON.stringify(check5SpawnedIds));
      check("Check5 setup: exactly 1 biter spawned in the arena", check5SpawnedIds.length === 1, JSON.stringify(check5SpawnedIds));

      const combatRaw = await callToolRaw(mcp.client, "combat_until", { companionId: POSITIVE_ID, targetType: "biter", maxKills: 1 });
      console.log("combat_until (Check5) ->", combatRaw);

      const { status, result } = await pollUntilSkillDone(mcp, POSITIVE_ID);
      done5Result = result;
      done5Status = status;
      console.log("companion_status after Check5 ->", JSON.stringify(status));
      console.log("Parsed SKILL_RESULT (Check5) ->", JSON.stringify(result));

      const cleanup5 = await destroySpawnedUnits(rcon, check5SpawnedIds);
      console.log("Check5: teardown of any surviving spawned biter(s) ->", JSON.stringify(cleanup5));
    }

    check("Check5 (Done-when): SKILL_RESULT reports kills:1", done5Result?.kills === 1, JSON.stringify(done5Result));
    check("Check5 (Done-when): SKILL_RESULT reports outcome:'success'", done5Result?.outcome === "success", JSON.stringify(done5Result));
    check("Check5 (Done-when): lastSkillResult.exitCode === 0", done5Status?.lastSkillResult?.exitCode === 0, JSON.stringify(done5Status?.lastSkillResult));

    const postInv = await callTool(mcp.client, "companion_inventory", { companionId: POSITIVE_ID });
    console.log("Armed companion's main inventory after combat ->", JSON.stringify(postInv));
    check(
      "Check5: companion's own inventory was never written by the test between spawn and combat",
      JSON.stringify(preInv.items) === JSON.stringify(postInv.items),
      JSON.stringify({ before: preInv.items, after: postInv.items })
    );

    // -----------------------------------------------------------
    // Check 6: unarmed hard-fail - guard rejects directly, combat_until fails fast
    // -----------------------------------------------------------
    console.log("\n=== Check 6: unarmed hard-fail (action_attack_start guard + fast combat_until termination) ===");
    const preHardfailMain = await readPlayerMainInvCounts(rcon, [
      ["submachine-gun", "smg"],
      ["rocket-launcher", "launcher"],
    ]);
    console.log("Player main inventory before unarmed hard-fail spawn ->", JSON.stringify(preHardfailMain));
    check(
      "Check6 setup: player's main inventory has no gun left over from earlier checks",
      preHardfailMain.smg === 0 && preHardfailMain.launcher === 0,
      JSON.stringify(preHardfailMain)
    );

    await clearStaleCompanion(mcp, rcon, UNARMED_HARDFAIL_ID);
    const hardfailSpawn = await callTool(mcp.client, "companion_spawn", { companionId: UNARMED_HARDFAIL_ID });
    spawnedIds.push(UNARMED_HARDFAIL_ID);
    console.log("companion_spawn (unarmed hard-fail) ->", JSON.stringify(hardfailSpawn));
    check(
      "Check6 setup: companion spawned genuinely fresh (spawned:true, not status:'exists')",
      hardfailSpawn.spawned === true,
      JSON.stringify(hardfailSpawn)
    );
    if (hardfailSpawn.spawned !== true) {
      throw new Error(
        `Companion ${UNARMED_HARDFAIL_ID} did not spawn fresh (${JSON.stringify(hardfailSpawn)}) - stale-companion cleanup failed to clear ` +
          "it, so this spawn skipped spawn-time arming and every downstream Check6 assertion would be meaningless. Aborting immediately."
      );
    }
    check("Check6 setup: companion spawned unarmed", hardfailSpawn.armed === false, JSON.stringify(hardfailSpawn));

    const hardfailPos = await callTool(mcp.client, "companion_position", { companionId: UNARMED_HARDFAIL_ID });
    const attackStartResult = await callTool(mcp.client, "action_attack_start", {
      companionId: UNARMED_HARDFAIL_ID,
      x: hardfailPos.position.x + 5,
      y: hardfailPos.position.y,
    });
    console.log("action_attack_start (unarmed hard-fail, direct) ->", JSON.stringify(attackStartResult));
    check(
      "Check6: action_attack_start on an unarmed companion returns {error:'No weapon equipped'} rather than starting a queue",
      attackStartResult?.error === "No weapon equipped",
      JSON.stringify(attackStartResult)
    );

    // combat_until's main() scans for enemies FIRST and short-circuits to outcome:"no-targets"
    // before it ever reaches action_attack_start's unarmed guard - so outcome:"unarmed" is only
    // reachable with an actual target in range. Without an arena target here, this check could
    // only ever observe "no-targets" (itself correct behaviour, verified separately) and would
    // never exercise the unarmed guard at all - the bug this FIX 2 addresses.
    const hardfailArenaSpot = await findSafeArenaSpot(rcon, { x: hardfailPos.position.x, y: hardfailPos.position.y });
    console.log("Check6: arena spot ->", JSON.stringify(hardfailArenaSpot));
    check(
      "Check6 setup: a safe arena spot (clear of spawners/turrets/worms) was found",
      hardfailArenaSpot.found === true,
      JSON.stringify(hardfailArenaSpot)
    );

    let hardfailResult: SkillResult | null = null;
    let hardfailStatus: any = null;
    let hardfailElapsed = -1;

    if (hardfailArenaSpot.found) {
      const hardfailTeleport = await teleportCompanionToArena(
        rcon,
        hardfailPos.position.x,
        hardfailPos.position.y,
        hardfailArenaSpot.x!,
        hardfailArenaSpot.y!
      );
      console.log("Check6: teleport into arena ->", JSON.stringify(hardfailTeleport));
      check("Check6 setup: companion teleported into the arena", hardfailTeleport.teleported === true, JSON.stringify(hardfailTeleport));

      const hardfailTargetCenter = { x: hardfailArenaSpot.x! + ARENA_ENGAGE_DISTANCE, y: hardfailArenaSpot.y! };
      check6SpawnedIds = await spawnBiters(rcon, clusterPositions(hardfailTargetCenter, 1, 0));
      console.log("Check6: spawned biter(s) ->", JSON.stringify(check6SpawnedIds));
      check("Check6 setup: exactly 1 biter spawned in the arena", check6SpawnedIds.length === 1, JSON.stringify(check6SpawnedIds));

      const hardfailStart = Date.now();
      const combatHardfailRaw = await callToolRaw(mcp.client, "combat_until", { companionId: UNARMED_HARDFAIL_ID, targetType: "all", maxKills: 1 });
      console.log("combat_until (unarmed hard-fail) ->", combatHardfailRaw);
      const { status, result } = await pollUntilSkillDone(mcp, UNARMED_HARDFAIL_ID);
      hardfailElapsed = Date.now() - hardfailStart;
      hardfailStatus = status;
      hardfailResult = result;
      console.log(`Check6: combat_until on unarmed companion finished in ${hardfailElapsed}ms ->`, JSON.stringify(hardfailResult));

      const check6Cleanup = await destroySpawnedUnits(rcon, check6SpawnedIds);
      console.log("Check6: teardown of any surviving spawned biter(s) ->", JSON.stringify(check6Cleanup));
    }

    check("Check6: combat_until on an unarmed companion terminates with outcome:'unarmed'", hardfailResult?.outcome === "unarmed", JSON.stringify(hardfailResult));
    check(
      "Check6: unarmedReason reports 'No weapon equipped'",
      hardfailResult?.unarmedReason === "No weapon equipped",
      JSON.stringify(hardfailResult)
    );
    check(
      `Check6: combat_until on an unarmed companion terminates well under the 30-attempt worst case (< ${UNARMED_FAST_FAIL_BUDGET_MS}ms, took ${hardfailElapsed}ms)`,
      hardfailElapsed >= 0 && hardfailElapsed < UNARMED_FAST_FAIL_BUDGET_MS,
      `elapsed=${hardfailElapsed}ms`
    );
    check(
      "Check6: lastSkillResult.exitCode !== 0 (unarmed is not success)",
      hardfailStatus?.lastSkillResult?.exitCode !== 0,
      JSON.stringify(hardfailStatus?.lastSkillResult)
    );
  } finally {
    console.log("\n--- Cleanup ---");
    for (const id of spawnedIds) {
      try {
        await callToolRaw(mcp.client, "companion_stop", { companionId: id });
      } catch (e) {
        console.log(`Cleanup companion_stop(${id}) failed (reporting, not hiding):`, e);
      }
    }

    // Disappear every companion this run spawned so the world is clean for the next run - this
    // is the fix for the exact defect this suite hunts: a companion left alive here makes the
    // NEXT run's companion_spawn take the {status:"exists"} no-op branch instead of a fresh,
    // spawn-time-armed one (the root cause of the 20/36 live run this fix responds to).
    for (const id of spawnedIds) {
      try {
        await clearStaleCompanion(mcp, rcon, id);
      } catch (e) {
        console.log(`Cleanup companion_disappear(${id}) failed (reporting, not hiding):`, e);
      }
    }

    // Final safety net for Check5/Check6's arena biter(s): each already tears its own spawns
    // down right after combat, but redo it here too in case an exception fired in between (e.g.
    // the combat_until call itself threw). destroySpawnedUnits is a no-op for ids already dead.
    const arenaSurvivors = [...check5SpawnedIds, ...check6SpawnedIds];
    if (arenaSurvivors.length > 0) {
      try {
        const finalArenaCleanup = await destroySpawnedUnits(rcon, arenaSurvivors);
        console.log("Cleanup: final teardown of any surviving arena-spawned biter(s) ->", JSON.stringify(finalArenaCleanup));
      } catch (e) {
        console.log("Cleanup arena biter removal failed (reporting, not hiding):", e);
      }
    }

    // Strip any gun/ammo this harness staged (or the mod transferred) from every companion
    // spawned during this test AND the player's main inventory, so the world nets to zero items
    // added - but bounded by stagedTotals (the real insert() amounts from Check3; Check4's own
    // launcher+mag are already self-cleaned right after Check4). A flat "remove up to 10/200"
    // quota here would happily eat pre-existing player stock of these exact item names that this
    // test never staged - same bug class as t021-combat-kills.ts's teardown asymmetry. Budget is
    // drained from companions first (where a transferred item ends up), remainder from the
    // player's main inventory (a staged-but-never-spawned leftover), so total removal across both
    // never exceeds what was actually staged.
    try {
      const cleanupRaw = await silent(
        rcon,
        `
          local __player = game.players[1]
          local gun_budget = {["submachine-gun"] = ${stagedTotals["submachine-gun"]}, ["rocket-launcher"] = ${stagedTotals["rocket-launcher"]}}
          local ammo_budget = {["firearm-magazine"] = ${stagedTotals["firearm-magazine"]}}
          for _, e in ipairs(__player.surface.find_entities_filtered{name="character"}) do
            if e.valid and e ~= __player.character then
              local guns_inv = e.get_inventory(defines.inventory.character_guns)
              local ammo_inv = e.get_inventory(defines.inventory.character_ammo)
              for n, budget in pairs(gun_budget) do
                if budget > 0 then
                  local removed = guns_inv.remove{name = n, count = budget}
                  gun_budget[n] = budget - removed
                end
              end
              for n, budget in pairs(ammo_budget) do
                if budget > 0 then
                  local removed = ammo_inv.remove{name = n, count = budget}
                  ammo_budget[n] = budget - removed
                end
              end
            end
          end
          local main_inv = __player.get_main_inventory()
          local player_removed = {}
          for n, budget in pairs(gun_budget) do
            if budget > 0 then player_removed[n] = main_inv.remove{name = n, count = budget} end
          end
          for n, budget in pairs(ammo_budget) do
            if budget > 0 then player_removed[n] = main_inv.remove{name = n, count = budget} end
          end
          rcon.print(helpers.table_to_json({player_removed = player_removed}))
        `
      );
      console.log(
        `Cleanup: stripped staged gun/ammo from companions + player main inventory (budget: ${JSON.stringify(stagedTotals)}) ->`,
        cleanupRaw
      );
    } catch (e) {
      console.log("Cleanup weapon removal failed (reporting, not hiding):", e);
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
