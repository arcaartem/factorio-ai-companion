// Live smoke test for T-051 + T-044 (mod 0.21.0/0.21.1): combat parity - the weapon/ammo gate,
// reach binding on the aim point, nearest-hostile targeting, the ground-fire fallback, the chase
// leash/stall, and fac_companion_stop_all correctly clearing shooting_state on BOTH the
// queue-based (action_attack_start) and queue-less (action_attack) combat paths.
//
// THIS SUITE REQUIRES AN INTERACTIVE, CLIENT-CONNECTED FACTORIO GAME. With no client connected
// game.players[1] has no character, so a spawned companion has nothing to arm itself FROM
// (companion.lua's arm_from takes a gun+ammo out of game.players[1]'s main inventory) and every
// weapon-gated command below short-circuits before it ever reaches the code this suite exists to
// verify. Do not attempt this against the disposable headless server (test-server.ts) - see
// t030-parity-residue.ts's header for the same limitation on the combat half of that suite.
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t051-combat-parity.ts
//
// Contract under test:
//   - fac_action_attack (action.lua:4-54): reach-binds the AIM POINT (check_reach, default kind
//     reach_distance = 10) before anything else; arms from the companion's own inventory and
//     gates on {error:"No weapon equipped"} / {error:"No ammo"}; resolves the NEAREST
//     unit/unit-spawner within radius 2 of the aim point (excluding characters); falls back to a
//     deliberate ground-fire shot when nothing resolves. It creates NO combat queue.
//   - queues.start_combat (queues.lua:779-820), driven via fac_action_attack_start: the same
//     reach bind and weapon/ammo gate, then a radius-10 enemy search; on success it creates
//     storage.combat_queues[cid] and clears the previous round's storage.combat_results[cid].
//   - tick_combat_queues (queues.lua:857-917): COMBAT_LEASH_DIST = 30 tiles from the round's
//     ORIGIN (the companion's position when start_combat was called), COMBAT_STALL_TICKS = 600
//     (10s with no progress on the current target). finish_combat reason is exactly one of
//     "cleared" / "leashed" / "stalled" / "stopped".
//   - fac_action_attack_status (combat.lua:59-67): results are NESTED under `status`. Inactive ->
//     {active:false, kills, ended_tick, uncaused_deaths, reason}; active ->
//     {active:true, targets_remaining, current_target, kills, uncaused_deaths} (no reason field).
//   - fac_companion_stop_all (companion.lua:166+, mod 0.21.1): now calls queues.stop_combat(id)
//     UNCONDITIONALLY (queues.lua:945-971 clears shooting_state to not_shooting BEFORE its
//     `if not q then return` early exit), and only appends "combat" to its own `stopped` list
//     when a queue genuinely existed. This is what makes stop_all finally able to silence a
//     companion that fac_action_attack set firing directly (no queue at all) - the bug this
//     suite's section 7 exists to catch a regression of.
//
// Sections (companion 51 - a fresh id, not used elsewhere in this directory):
//   Banner (gating) - unarmed companion, action_attack near ~3 tiles -> attacking:false. Throws
//     on attacking:true (stale pre-0.21.0 code) rather than scoring. NOTE: this banner
//     discriminates 0.21.0 but NOT 0.21.1 - the 0.21.1 stop_all fix (section 7) has no analogous
//     "old code always does X" tell to gate on; its deployment is guaranteed by the operator's
//     `diff -rq` gate before this suite is run, not by anything this banner can observe.
//   1. Weapon/ammo gate (T-051 clause 1) - unarmed -> "No weapon equipped" from both
//      action_attack and action_attack_start, shooting_state stays not_shooting; gun-but-no-ammo
//      -> "No ammo" from both, same shooting_state assertion.
//   2. Out-of-reach aim point (T-051 clause 3) - armed companion, ~25 tiles -> {error:"Too far",
//      reach:10}; ~5 tiles -> not refused.
//   3. Nearest-hostile targeting (T-051 clause 2) - two biters at known, different distances
//      (0.6 / 1.8 tiles) from one aim point inside radius 2; action_attack's returned `position`
//      must match the NEARER one, not the farther. A distractor tree (closer than both biters)
//      proves type filtering, not just distance, decides the target.
//   4. Ground-fire fallback (documented behaviour, pinned) - no enemy within radius 2 ->
//      attacking:true, target:"ground".
//   5. Chase leash (T-051 clause 4) - action_attack_start on a biter, then teleport that biter
//      90 tiles away so the chase drags the companion past COMBAT_LEASH_DIST (30) from its
//      origin; terminal reason is "leashed" or "stalled" (the card accepts either).
//   6. T-044 clause A - stop_all on a QUEUE-BASED round (action_attack_start): shooting_state
//      clears to not_shooting, reply's `stopped` includes "combat", terminal reason "stopped".
//   7. T-044 clause B (the 0.21.1 fix, most important section here) - stop_all on the
//      QUEUE-LESS fac_action_attack path: shooting_state clears to not_shooting, but the reply's
//      `stopped` list does NOT include "combat" (no queue ever existed - the response contract
//      is deliberately unchanged by the fix).
import { connectMCP, connectRCON, callTool, check, summary, silent } from "./lib";
import { asArray } from "../../src/utils/connection";

const ID = 51;
const GUN = "submachine-gun";
const AMMO = "firearm-magazine";
const AMMO_COUNT = 50;
const REACH_LIMIT = 10; // c.entity.reach_distance, player-parity default (init.lua check_reach)
const POS_EPS = 0.5; // generous vs. the >=1.2 tile gap between the near/far biters in section 3 -
// small-biters have autonomous AI and can drift a little between spawn and the attack call
const ARENA_SAFETY_RADIUS = 30; // min distance from any enemy spawner/turret/worm (worms are prototype type="turret")
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
const LEASH_WAIT_TIMEOUT_MS = 45000; // >= the 30s wall-clock floor the spec asks for, plus margin
const STOP_POLL_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 1500;
const PRECONDITION_POLL_TIMEOUT_MS = 10000;
const PRECONDITION_POLL_INTERVAL_MS = 400;

type RCON = { send: (cmd: string) => Promise<string> };
type Pos = { x: number; y: number };

const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** silent() returns raw text; every probe here answers with one helpers.table_to_json line. */
async function lua(rcon: RCON, body: string): Promise<any> {
  const raw = await silent(rcon, body);
  const line = raw.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`no JSON in RCON reply: ${raw.slice(0, 300)}`);
  return JSON.parse(line);
}

/** /silent-command has no access to storage.companions, so this is the only way to resolve "the
 *  entity for companion id 51" from a side channel - there is only ever one companion alive in
 *  this suite, so a moderate lookup radius (vs. t026's tight 1.5) is safe against small
 *  positional drift between the last known position and the read. */
function findEntityNearLua(x: number, y: number, radius = 3): string {
  return `
    local __player = game.players[1]
    local __target
    for _, e in ipairs(__player.surface.find_entities_filtered{name="character", position={x=${x}, y=${y}}, radius=${radius}}) do
      if e.valid and e ~= __player.character then __target = e; break end
    end
    if not __target then rcon.print(helpers.table_to_json({error = "companion not found"})); return end
  `;
}

/** Canonical position source - the real mod command, which resolves storage.companions and is
 *  unaffected by however far the entity has physically walked since the last side-channel read. */
async function companionPos(mcp: { client: any }, id: number): Promise<Pos> {
  const r = await callTool(mcp.client, "companion_position", { companionId: id });
  if (!r?.position) throw new Error(`companion ${id} has no position: ${JSON.stringify(r)}`);
  return r.position;
}

/** Reads shooting_state and walking_state directly off the entity - the decisive check throughout
 *  this suite, since a command's own reply is not proof the engine state actually changed. */
async function readEntityState(rcon: RCON, pos: Pos): Promise<{ shooting: string; walking: boolean }> {
  const r = await lua(
    rcon,
    findEntityNearLua(pos.x, pos.y) +
      `
      local st = __target.shooting_state.state
      local name = "unknown"
      if st == defines.shooting.not_shooting then name = "not_shooting"
      elseif st == defines.shooting.shooting_enemies then name = "shooting_enemies"
      elseif st == defines.shooting.shooting_selected then name = "shooting_selected" end
      rcon.print(helpers.table_to_json({shooting = name, walking = __target.walking_state.walking}))
    `
  );
  return r;
}

async function readShootingStateForCompanion(mcp: { client: any }, rcon: RCON, id: number): Promise<string> {
  const pos = await companionPos(mcp, id);
  const s = await readEntityState(rcon, pos);
  return s.shooting;
}

/** Checks the player's main inventory (the pool companion_spawn's arm_from draws from) for any
 *  gun/ammo-type items. This suite never arms via the player's inventory at all - every gun/ammo
 *  it needs is conjured directly into the companion's own equipped slots (harness-sanctioned
 *  staging, same precedent as t026/t030's setCompanionItems/giveCompanionItems) - so it must
 *  never touch or destroy anything the player actually owns. If the player's main inventory
 *  already holds a gun or ammo, companion_spawn would arm the companion FOR us and the Banner's
 *  unarmed precondition would be false through no fault of the mod; that is a setup problem for
 *  the operator to fix (empty the player's main inventory), not something this suite silently
 *  works around by moving or destroying real player items. */
async function playerMainWeaponCheck(rcon: RCON): Promise<{ hasGun: boolean; hasAmmo: boolean; guns: string[]; ammo: string[] }> {
  return lua(
    rcon,
    `
      local inv = game.players[1].get_main_inventory()
      local guns, ammo = {}, {}
      for _, item in ipairs(inv.get_contents()) do
        local proto = prototypes.item[item.name]
        if proto and proto.type == "gun" then guns[#guns + 1] = item.name end
        if proto and proto.type == "ammo" then ammo[#ammo + 1] = item.name end
      end
      rcon.print(helpers.table_to_json({hasGun = #guns > 0, hasAmmo = #ammo > 0, guns = guns, ammo = ammo}))
    `
  );
}

/** Conjures `gunName` directly into the companion's character_guns slot, bypassing arm_from
 *  entirely - required for the "gun equipped but no ammo" state in section 1, since arm_from's
 *  own gun-selection loop refuses to equip a gun from the main inventory unless MATCHING ammo is
 *  also present there (init.lua:386-396), which would make that state unreachable through the
 *  normal path. This mirrors a real, reachable scenario: a companion whose loaded ammo was spent
 *  firing in a previous round. Safe to insert without clearing first - guns_inv is verified empty
 *  by the Banner's precondition (player's main inventory had nothing for spawn-time arm_from to
 *  transfer). */
async function stageGunOnly(rcon: RCON, pos: Pos, gunName: string): Promise<void> {
  await lua(
    rcon,
    findEntityNearLua(pos.x, pos.y) +
      `
      local guns_inv = __target.get_inventory(defines.inventory.character_guns)
      guns_inv.insert{name = "${gunName}", count = 1}
      __target.selected_gun_index = 1
      rcon.print(helpers.table_to_json({ok = true}))
    `
  );
}

/** Conjures ammo directly into character_ammo, completing the arming started by stageGunOnly.
 *  Same non-destructive reasoning: ammo_inv is empty at this point in the run. */
async function stageAmmo(rcon: RCON, pos: Pos, ammoName: string, count: number): Promise<void> {
  await lua(
    rcon,
    findEntityNearLua(pos.x, pos.y) +
      `
      local ammo_inv = __target.get_inventory(defines.inventory.character_ammo)
      ammo_inv.insert{name = "${ammoName}", count = ${count}}
      rcon.print(helpers.table_to_json({ok = true}))
    `
  );
}

async function readGunAmmoState(rcon: RCON, pos: Pos): Promise<{ gun: string; gunCount: number; ammo: string; ammoCount: number }> {
  return lua(
    rcon,
    findEntityNearLua(pos.x, pos.y) +
      `
      local guns = __target.get_inventory(defines.inventory.character_guns)
      local ammoInv = __target.get_inventory(defines.inventory.character_ammo)
      local g1 = guns[1] and guns[1].valid_for_read
      local a1 = ammoInv[1] and ammoInv[1].valid_for_read
      rcon.print(helpers.table_to_json({
        gun = g1 and guns[1].name or "",
        gunCount = g1 and 1 or 0,
        ammo = a1 and ammoInv[1].name or "",
        ammoCount = a1 and ammoInv[1].count or 0
      }))
    `
  );
}

interface ArenaSpot {
  found: boolean;
  x?: number;
  y?: number;
}

/** Finds a staging point clear of enemy spawners/turrets/worms (worms are prototype type="turret"
 *  too) within ARENA_SAFETY_RADIUS. Verbatim shape from t026-companion-arming.ts's
 *  findSafeArenaSpot / t021-combat-kills.ts's copy of the same. `found` is always present. */
async function findSafeArenaSpot(rcon: RCON, ref: Pos): Promise<ArenaSpot> {
  const offsetsLua = ARENA_CANDIDATE_OFFSETS.map((o) => `{dx=${o.dx}, dy=${o.dy}}`).join(", ");
  return lua(
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
}

/** Teleports the companion currently near (curX, curY) to (destX, destY). Test-harness-only -
 *  the mod's own gameplay code never teleports a companion. Verbatim shape from t026. */
async function teleportCompanionToArena(rcon: RCON, curX: number, curY: number, destX: number, destY: number): Promise<{ teleported: boolean }> {
  return lua(
    rcon,
    findEntityNearLua(curX, curY) +
      `
      local dest = __target.surface.find_non_colliding_position("character", {x=${destX}, y=${destY}}, 10, 0.5)
      local teleported = false
      if dest then teleported = __target.teleport(dest) end
      rcon.print(helpers.table_to_json({teleported = teleported}))
    `
  );
}

/** Spawns small-biters (force "enemy") at the given positions via create_entity, nudged onto the
 *  nearest non-colliding tile within 3 tiles, and reports the ENGINE's real (possibly snapped)
 *  position and unit_number for each. Verbatim idea from t026/t021's spawnBiters, extended to
 *  return positions too - section 3's decisive "matches the nearer biter's position" assertion
 *  needs the real snapped coordinates, not the requested ones, so every section here uses this
 *  variant rather than an ids-only one. */
async function spawnBitersAt(rcon: RCON, positions: Pos[]): Promise<Array<{ created: boolean; x: number; y: number; unit_number: number }>> {
  const posLua = positions.map((p) => `{x=${p.x}, y=${p.y}}`).join(", ");
  const raw = await lua(
    rcon,
    `
      local surface = game.players[1].surface
      local positions = {${posLua}}
      local results = {}
      for _, p in ipairs(positions) do
        local spot = surface.find_non_colliding_position("small-biter", p, 3, 0.5) or p
        local e = surface.create_entity{name="small-biter", position=spot, force="enemy"}
        if e and e.valid then
          results[#results + 1] = {created = true, x = e.position.x, y = e.position.y, unit_number = e.unit_number}
        else
          results[#results + 1] = {created = false, x = 0, y = 0, unit_number = -1}
        end
      end
      rcon.print(helpers.table_to_json({results = results}))
    `
  );
  return asArray(raw.results);
}

/** Destroys any still-alive spawned units by unit_number, scanning the WHOLE surface (not bounded
 *  by position - a leashed/teleported biter may be far from where it started). No-op for ids
 *  already dead. Verbatim shape from t026/t021. */
async function destroySpawnedUnits(rcon: RCON, ids: number[]): Promise<{ destroyed: number }> {
  if (ids.length === 0) return { destroyed: 0 };
  const idSetLua = ids.map((id) => `[${id}] = true`).join(", ");
  return lua(
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
}

/** Teleports one specific enemy unit (by unit_number) far away - section 5's leash trigger.
 *  Scans the whole surface by force+type, same reasoning as destroySpawnedUnits. */
async function teleportEnemyUnit(rcon: RCON, unitNumber: number, destPos: Pos): Promise<{ teleported: boolean; x: number; y: number }> {
  return lua(
    rcon,
    `
      local surface = game.players[1].surface
      local target
      for _, u in ipairs(surface.find_entities_filtered{type = "unit", force = "enemy"}) do
        if u.valid and u.unit_number == ${unitNumber} then target = u; break end
      end
      if not target then rcon.print(helpers.table_to_json({teleported = false, x = 0, y = 0})) return end
      local dest = surface.find_non_colliding_position(target.name, {x=${destPos.x}, y=${destPos.y}}, 5, 1) or {x=${destPos.x}, y=${destPos.y}}
      local ok = target.teleport(dest)
      rcon.print(helpers.table_to_json({teleported = ok, x = target.position.x, y = target.position.y}))
    `
  );
}

/** Optional distractor for section 3 - a tree closer than either biter, proving resolve_target's
 *  type filter (not just distance) picks the target. Trees are simple entities with a nil
 *  unit_number, so teardown must key on the exact recorded position instead. */
async function createTreeAt(rcon: RCON, pos: Pos): Promise<{ created: boolean; x: number; y: number }> {
  return lua(
    rcon,
    `
      local e = game.players[1].surface.create_entity{name = "tree-01", position = {x=${pos.x}, y=${pos.y}}}
      if not e or not e.valid then rcon.print(helpers.table_to_json({created = false, x = 0, y = 0})) return end
      rcon.print(helpers.table_to_json({created = true, x = e.position.x, y = e.position.y}))
    `
  );
}

async function destroyNear(rcon: RCON, name: string, pos: Pos, radius = 1): Promise<number> {
  const r = await lua(
    rcon,
    `
      local n = 0
      for _, e in ipairs(game.surfaces[1].find_entities_filtered{name = "${name}", position = {x=${pos.x}, y=${pos.y}}, radius = ${radius}}) do
        if e.valid then e.destroy(); n = n + 1 end
      end
      rcon.print(helpers.table_to_json({n = n}))
    `
  );
  return r.n;
}

/** Removes any companion at `id` left over from a previous run, same rationale as every other
 *  suite here: companion_spawn on a still-alive companion takes the {status:"exists"} no-op
 *  branch and skips spawn-time work entirely, which would invalidate this run's own setup. */
async function clearStaleCompanion(mcp: { client: any }, id: number): Promise<void> {
  const posRes = await callTool(mcp.client, "companion_position", { companionId: id });
  if (!posRes?.position) {
    console.log(`Stale-companion cleanup: no companion ${id} present (clean start).`);
    return;
  }
  const disappear = await callTool(mcp.client, "companion_disappear", { companionId: id });
  console.log(`Stale-companion cleanup: removed companion ${id} ->`, JSON.stringify(disappear));
}

/** Sweeps item-on-ground residue near a position - used after companion_disappear, which spills
 *  the companion's guns/ammo (spill_equipment) rather than destroying them. Sums stack counts,
 *  never entity counts (a stack can split across several item-entity entities). */
async function sweepGround(rcon: RCON, at: Pos, radius = 10): Promise<number> {
  const r = await lua(
    rcon,
    `
      local n = 0
      for _, e in ipairs(game.surfaces[1].find_entities_filtered{position = {x=${at.x}, y=${at.y}}, radius = ${radius}, name = "item-on-ground"}) do
        if e.valid then n = n + (e.stack and e.stack.valid_for_read and e.stack.count or 0) e.destroy() end
      end
      rcon.print(helpers.table_to_json({swept = n}))
    `
  );
  return r.swept;
}

async function pollUntilInactive(mcp: { client: any }, id: number, timeoutMs: number): Promise<any> {
  const start = Date.now();
  let status: any = null;
  while (Date.now() - start < timeoutMs) {
    const res = await callTool(mcp.client, "action_attack_status", { companionId: id });
    status = res?.status;
    if (status?.active === false) return status;
    console.log(`  ...combat still active, elapsed ${Date.now() - start}ms, status=${JSON.stringify(status)}`);
    await sleep(POLL_INTERVAL_MS);
  }
  return status;
}

/** Waits for a QUEUE-BASED round to reach active:true AND shooting_state == shooting_enemies -
 *  the precondition section 6 needs before it can decisively test stop_all against a live round. */
async function waitForActiveShooting(mcp: { client: any }, rcon: RCON, id: number, timeoutMs: number): Promise<{ active: boolean; shooting: string }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await callTool(mcp.client, "action_attack_status", { companionId: id });
    if (res?.status?.active === true) {
      const shooting = await readShootingStateForCompanion(mcp, rcon, id);
      if (shooting === "shooting_enemies") return { active: true, shooting };
    }
    await sleep(PRECONDITION_POLL_INTERVAL_MS);
  }
  const shooting = await readShootingStateForCompanion(mcp, rcon, id).catch(() => "unknown");
  return { active: false, shooting };
}

async function section(label: string, banner: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  await body();
}

async function main(): Promise<void> {
  const mcp = await connectMCP();
  const rcon = await connectRCON();
  // Every create_entity'd unit this run spawns, tracked by unit_number BEFORE anything that can
  // throw - swept in the top-level finally regardless of where an exception lands.
  const spawnedUnitIds: number[] = [];
  // Trees have a nil unit_number (simple entities) - tracked by exact position instead.
  const spawnedTreePositions: Pos[] = [];

  try {
    // ================================================================================
    console.log("=== Setup: verify the player's main inventory has no gun/ammo, then spawn companion 51 ===");
    const preCheck = await playerMainWeaponCheck(rcon);
    console.log("Player main inventory weapon check ->", JSON.stringify(preCheck));
    if (preCheck.hasGun || preCheck.hasAmmo) {
      throw new Error(
        `Player's main inventory already holds a gun/ammo (${JSON.stringify(preCheck)}) - this suite needs a genuinely unarmed ` +
          "spawn for its Banner/section 1, and will not silently move or destroy real player items to force one. Clear the " +
          "player's main inventory (equipped slots are fine, untouched by arm_from) and re-run."
      );
    }

    await clearStaleCompanion(mcp, ID);
    const spawn = await callTool(mcp.client, "companion_spawn", { companionId: ID });
    console.log("companion_spawn(51) ->", JSON.stringify(spawn));
    check("setup: companion 51 spawned fresh (spawned:true, not status:'exists')", spawn?.spawned === true, JSON.stringify(spawn));
    if (spawn?.spawned !== true) throw new Error("cannot proceed without a fresh companion");
    check("setup: companion spawned genuinely unarmed (armed:false)", spawn?.armed === false, JSON.stringify(spawn));

    let pos = await companionPos(mcp, ID);
    let entityState = await readEntityState(rcon, pos);
    check("setup: fresh companion's shooting_state is not_shooting", entityState.shooting === "not_shooting", JSON.stringify(entityState));

    // ================================================================================
    // BANNER (gating): unarmed companion, action_attack near ~3 tiles must refuse with
    // attacking:false. Pre-0.21.0 code reported attacking:true unconditionally, with no gate at
    // all - so attacking:true here means the running mod predates 0.21.0 and every section below
    // would be scoring against dead code. NOTE: this banner discriminates 0.21.0 but NOT 0.21.1 -
    // the 0.21.1 stop_all fix (section 7) has no analogous "old code always does X" tell; its
    // deployment is guaranteed by the operator's `diff -rq` gate before this suite runs, not by
    // anything observable from here.
    // ================================================================================
    console.log("\n=== BANNER: unarmed action_attack must refuse, not fire ===");
    const bannerAim = { x: pos.x + 3, y: pos.y };
    const bannerRes = await callTool(mcp.client, "action_attack", { companionId: ID, x: bannerAim.x, y: bannerAim.y });
    console.log("action_attack (banner, unarmed) ->", JSON.stringify(bannerRes));
    if (bannerRes?.attacking === true) {
      throw new Error(
        `STALE MOD CODE: action_attack on a genuinely unarmed companion returned attacking:true (${JSON.stringify(bannerRes)}). ` +
          "Pre-0.21.0 code had no weapon/ammo gate at all and always attacked. Re-deploy factorio-mod/ (diff -rq gate) before " +
          "running this suite again."
      );
    }
    check("BANNER: unarmed action_attack refuses with attacking:false", bannerRes?.attacking === false, JSON.stringify(bannerRes));
    check("BANNER: refusal carries error 'No weapon equipped'", bannerRes?.error === "No weapon equipped", JSON.stringify(bannerRes));

    // ================================================================================
    await section("1", "Weapon/ammo gate (T-051 clause 1)", async () => {
      pos = await companionPos(mcp, ID);

      // ---- 1a: still fully unarmed - action_attack_start must refuse the same way. ----
      const aim = { x: pos.x + 3, y: pos.y };
      const startRes = await callTool(mcp.client, "action_attack_start", { companionId: ID, x: aim.x, y: aim.y });
      console.log("action_attack_start (unarmed) ->", JSON.stringify(startRes));
      check("1.1: action_attack_start on an unarmed companion returns 'No weapon equipped'", startRes?.error === "No weapon equipped", JSON.stringify(startRes));
      let state = await readEntityState(rcon, pos);
      check("1.2 DECISIVE: shooting_state is still not_shooting after the action_attack_start refusal", state.shooting === "not_shooting", JSON.stringify(state));

      const attackRes = await callTool(mcp.client, "action_attack", { companionId: ID, x: aim.x, y: aim.y });
      console.log("action_attack (unarmed, repeat) ->", JSON.stringify(attackRes));
      check("1.3: action_attack on an unarmed companion returns attacking:false", attackRes?.attacking === false, JSON.stringify(attackRes));
      check("1.4: refusal carries error 'No weapon equipped'", attackRes?.error === "No weapon equipped", JSON.stringify(attackRes));
      state = await readEntityState(rcon, pos);
      check("1.5 DECISIVE: shooting_state is still not_shooting after the action_attack refusal", state.shooting === "not_shooting", JSON.stringify(state));

      // ---- 1b: gun equipped, but genuinely no ammo anywhere - "No ammo" from both commands. ----
      await stageGunOnly(rcon, pos, GUN);
      const staged = await readGunAmmoState(rcon, pos);
      console.log("Companion gun/ammo state after staging gun-only ->", JSON.stringify(staged));
      check("1.6 setup: gun staged, genuinely no ammo loaded", staged.gun === GUN && staged.ammoCount === 0, JSON.stringify(staged));
      if (!(staged.gun === GUN && staged.ammoCount === 0)) return;

      const attackNoAmmo = await callTool(mcp.client, "action_attack", { companionId: ID, x: aim.x, y: aim.y });
      console.log("action_attack (gun, no ammo) ->", JSON.stringify(attackNoAmmo));
      check("1.7: action_attack with a gun but no ammo returns attacking:false, error 'No ammo'", attackNoAmmo?.attacking === false && attackNoAmmo?.error === "No ammo", JSON.stringify(attackNoAmmo));
      state = await readEntityState(rcon, pos);
      check("1.8 DECISIVE: shooting_state is still not_shooting after the 'No ammo' refusal (action_attack)", state.shooting === "not_shooting", JSON.stringify(state));

      const startNoAmmo = await callTool(mcp.client, "action_attack_start", { companionId: ID, x: aim.x, y: aim.y });
      console.log("action_attack_start (gun, no ammo) ->", JSON.stringify(startNoAmmo));
      check("1.9: action_attack_start with a gun but no ammo returns error 'No ammo'", startNoAmmo?.error === "No ammo", JSON.stringify(startNoAmmo));
      state = await readEntityState(rcon, pos);
      check("1.10 DECISIVE: shooting_state is still not_shooting after the 'No ammo' refusal (action_attack_start)", state.shooting === "not_shooting", JSON.stringify(state));
    });

    // Arm the companion for real, for every section from here on - conjure matching ammo
    // straight into character_ammo (ammo_inv is still empty; the gun from section 1b is already
    // equipped). This is the only arming this suite ever does; nothing from here on touches the
    // player's inventory.
    pos = await companionPos(mcp, ID);
    await stageAmmo(rcon, pos, AMMO, AMMO_COUNT);
    const armedState = await readGunAmmoState(rcon, pos);
    console.log("Companion gun/ammo state after arming ->", JSON.stringify(armedState));
    check("setup: companion genuinely armed (gun + ammo) ahead of sections 2-7", armedState.gun === GUN && armedState.ammoCount > 0, JSON.stringify(armedState));
    if (!(armedState.gun === GUN && armedState.ammoCount > 0)) {
      throw new Error(`Failed to arm companion ${ID} for sections 2-7 (${JSON.stringify(armedState)}) - aborting the rest of the suite.`);
    }

    // ================================================================================
    await section("2", "Out-of-reach aim point (T-051 clause 3)", async () => {
      pos = await companionPos(mcp, ID);
      const farPoint = { x: pos.x + 25, y: pos.y };
      const dFar = dist(pos, farPoint);
      check("2 setup: far aim point is genuinely beyond reach (10)", dFar > REACH_LIMIT, `dist=${dFar.toFixed(2)}`);

      const farRes = await callTool(mcp.client, "action_attack", { companionId: ID, x: farPoint.x, y: farPoint.y });
      console.log("action_attack (far, ~25 tiles) ->", JSON.stringify(farRes));
      check("2.1: far aim point refuses with attacking:false, error 'Too far'", farRes?.attacking === false && farRes?.error === "Too far", JSON.stringify(farRes));
      check("2.2 DECISIVE: reach field reads the true limit (10)", farRes?.reach === REACH_LIMIT, JSON.stringify(farRes));
      check(`2.3 DECISIVE: distance field is close to the real ~${dFar.toFixed(1)} tiles`, typeof farRes?.distance === "number" && Math.abs(farRes.distance - dFar) <= 1, JSON.stringify({ reported: farRes?.distance, actual: dFar }));

      const nearPoint = { x: pos.x + 5, y: pos.y };
      const dNear = dist(pos, nearPoint);
      check("2 setup: near aim point is genuinely within reach (10)", dNear < REACH_LIMIT, `dist=${dNear.toFixed(2)}`);

      const nearRes = await callTool(mcp.client, "action_attack", { companionId: ID, x: nearPoint.x, y: nearPoint.y });
      console.log("action_attack (near, ~5 tiles) ->", JSON.stringify(nearRes));
      check("2.4 DECISIVE: near aim point is NOT refused for reach", nearRes?.error !== "Too far", JSON.stringify(nearRes));
      check("2.5: near aim point attacks (attacking:true) - proves the refusal above was the distance, not a blanket failure", nearRes?.attacking === true, JSON.stringify(nearRes));
    });

    // ================================================================================
    console.log("\n=== Setup: locate a controlled arena for sections 3-7 ===");
    pos = await companionPos(mcp, ID);
    const arenaSpot = await findSafeArenaSpot(rcon, pos);
    console.log("Arena spot ->", JSON.stringify(arenaSpot));
    check("arena setup: a safe spot (clear of spawners/turrets/worms) was found", arenaSpot.found === true, JSON.stringify(arenaSpot));
    if (!arenaSpot.found) throw new Error("no safe arena spot found - cannot run sections 3-7");

    const teleport = await teleportCompanionToArena(rcon, pos.x, pos.y, arenaSpot.x!, arenaSpot.y!);
    console.log("Teleport into arena ->", JSON.stringify(teleport));
    check("arena setup: companion teleported into the arena", teleport.teleported === true, JSON.stringify(teleport));
    if (!teleport.teleported) throw new Error("failed to teleport companion into the arena - cannot run sections 3-7");

    const arena: Pos = { x: arenaSpot.x!, y: arenaSpot.y! };

    // ================================================================================
    await section("3", "Nearest-hostile targeting (T-051 clause 2)", async () => {
      const aim = { x: arena.x + 5, y: arena.y };
      const nearBiterPos = { x: aim.x + 0.6, y: aim.y };
      const farBiterPos = { x: aim.x, y: aim.y + 1.8 };
      const treePos = { x: aim.x + 0.2, y: aim.y }; // distractor, CLOSER than either biter

      const dAim = dist(await companionPos(mcp, ID), aim);
      check("3 setup: aim point is within reach (10) of the companion", dAim < REACH_LIMIT, `dist=${dAim.toFixed(2)}`);

      const biters = await spawnBitersAt(rcon, [nearBiterPos, farBiterPos]);
      console.log("3: spawned biters ->", JSON.stringify(biters));
      check("3 setup: both biters created", biters.length === 2 && biters.every((b) => b.created), JSON.stringify(biters));
      if (!(biters.length === 2 && biters[0]!.created && biters[1]!.created)) return;
      spawnedUnitIds.push(biters[0]!.unit_number, biters[1]!.unit_number);
      const near = biters[0]!;
      const far = biters[1]!;

      const dNearReal = dist(aim, { x: near.x, y: near.y });
      const dFarReal = dist(aim, { x: far.x, y: far.y });
      check("3 setup: near biter's real (possibly snapped) position is still nearer the aim point than the far one", dNearReal < dFarReal, `near=${dNearReal.toFixed(2)} far=${dFarReal.toFixed(2)}`);
      check("3 setup: both biters are within resolve_target's search radius (2) of the aim point", dNearReal < 2 && dFarReal < 2, `near=${dNearReal.toFixed(2)} far=${dFarReal.toFixed(2)}`);

      const tree = await createTreeAt(rcon, treePos);
      console.log("3: distractor tree ->", JSON.stringify(tree));
      if (tree.created) spawnedTreePositions.push({ x: tree.x, y: tree.y });

      const res = await callTool(mcp.client, "action_attack", { companionId: ID, x: aim.x, y: aim.y });
      console.log("action_attack (nearest-hostile targeting) ->", JSON.stringify(res));
      check("3.1: action_attack attacks (attacking:true)", res?.attacking === true, JSON.stringify(res));
      check("3.2 DECISIVE: target is 'small-biter', not the tree or anything else", res?.target === "small-biter", JSON.stringify(res));
      const posMatch = res?.position && Math.abs(res.position.x - near.x) <= POS_EPS && Math.abs(res.position.y - near.y) <= POS_EPS;
      check("3.3 DECISIVE: returned position matches the NEARER biter's recorded position, not the farther one", posMatch, JSON.stringify({ returned: res?.position, near: { x: near.x, y: near.y }, far: { x: far.x, y: far.y } }));
      const posNotFar = !(res?.position && Math.abs(res.position.x - far.x) <= POS_EPS && Math.abs(res.position.y - far.y) <= POS_EPS);
      check("3.4 DECISIVE: returned position is NOT the farther biter's position", posNotFar, JSON.stringify(res?.position));

      const cleanup = await destroySpawnedUnits(rcon, [near.unit_number, far.unit_number]);
      console.log("3: teardown of spawned biters ->", JSON.stringify(cleanup));
      if (tree.created) {
        const treeCleanup = await destroyNear(rcon, "tree-01", { x: tree.x, y: tree.y }, 0.5);
        console.log("3: teardown of distractor tree ->", treeCleanup);
      }
    });

    // ================================================================================
    await section("4", "Ground-fire fallback (documented behaviour, pinned)", async () => {
      const aim = { x: arena.x - 5, y: arena.y };
      const dAim = dist(await companionPos(mcp, ID), aim);
      check("4 setup: aim point is within reach (10) of the companion", dAim < REACH_LIMIT, `dist=${dAim.toFixed(2)}`);

      const res = await callTool(mcp.client, "action_attack", { companionId: ID, x: aim.x, y: aim.y });
      console.log("action_attack (no enemy nearby, ground-fire fallback) ->", JSON.stringify(res));
      check("4.1 DECISIVE: with no enemy within radius 2, action_attack still attacks (attacking:true)", res?.attacking === true, JSON.stringify(res));
      check("4.2 DECISIVE: target is exactly 'ground'", res?.target === "ground", JSON.stringify(res));
      check("4.3: position echoes the requested aim point", res?.position && Math.abs(res.position.x - aim.x) <= POS_EPS && Math.abs(res.position.y - aim.y) <= POS_EPS, JSON.stringify(res?.position));
    });

    // ================================================================================
    await section("5", "Chase leash (T-051 clause 4)", async () => {
      const target = { x: arena.x, y: arena.y + 5 };
      const origin = await companionPos(mcp, ID);
      const dTarget = dist(origin, target);
      check("5 setup: initial target point is within reach (10) of the companion", dTarget < REACH_LIMIT, `dist=${dTarget.toFixed(2)}`);

      const biters = await spawnBitersAt(rcon, [target]);
      console.log("5: spawned biter ->", JSON.stringify(biters));
      check("5 setup: biter created", biters.length === 1 && biters[0]!.created, JSON.stringify(biters));
      if (!(biters.length === 1 && biters[0]!.created)) return;
      const biter = biters[0]!;
      spawnedUnitIds.push(biter.unit_number);

      const startRes = await callTool(mcp.client, "action_attack_start", { companionId: ID, x: target.x, y: target.y });
      console.log("action_attack_start (section 5) ->", JSON.stringify(startRes));
      check("5.1 setup: combat started ({started:true})", startRes?.started === true, JSON.stringify(startRes));
      if (startRes?.started !== true) {
        await destroySpawnedUnits(rcon, [biter.unit_number]);
        return;
      }

      const statusBefore = await callTool(mcp.client, "action_attack_status", { companionId: ID });
      console.log("action_attack_status (just after start) ->", JSON.stringify(statusBefore));
      check("5.2 setup: action_attack_status reads active:true right after start", statusBefore?.status?.active === true, JSON.stringify(statusBefore));

      // Relocate the SAME biter (by unit_number, not position - it may have already taken a step)
      // 90 tiles from the round's origin, well beyond COMBAT_LEASH_DIST (30). The chase in
      // tick_combat_queues is a raw bearing walk with no pathfinding, so it will keep closing on
      // the relocated target and drag the companion's own position away from `origin` until the
      // leash check trips - or, if something in between blocks the walk, until the stall check
      // does. The card accepts either.
      const farTarget = { x: origin.x, y: origin.y + 90 };
      const relocated = await teleportEnemyUnit(rcon, biter.unit_number, farTarget);
      console.log("5: teleported the engaged biter 90 tiles from origin ->", JSON.stringify(relocated));
      check("5.3 setup: engaged biter relocated far from the round's origin", relocated.teleported === true, JSON.stringify(relocated));

      console.log(`5: polling action_attack_status until inactive (timeout ${LEASH_WAIT_TIMEOUT_MS}ms) ...`);
      const finalStatus = await pollUntilInactive(mcp, ID, LEASH_WAIT_TIMEOUT_MS);
      console.log("action_attack_status (terminal, section 5) ->", JSON.stringify(finalStatus));
      check("5.4 DECISIVE: combat round eventually terminates (active:false)", finalStatus?.active === false, JSON.stringify(finalStatus));
      const reason = finalStatus?.reason;
      check(`5.5 DECISIVE: terminal reason is 'leashed' or 'stalled' (got '${reason}')`, reason === "leashed" || reason === "stalled", JSON.stringify(finalStatus));

      const afterPos = await companionPos(mcp, ID);
      const afterState = await readEntityState(rcon, afterPos);
      console.log("Companion state after the leash/stall termination ->", JSON.stringify(afterState));
      check("5.6: companion is not still walking after the round ended", afterState.walking === false, JSON.stringify(afterState));

      const cleanup = await destroySpawnedUnits(rcon, [biter.unit_number]);
      console.log("5: teardown of the (now-distant) biter ->", JSON.stringify(cleanup));
    });

    // ================================================================================
    await section("6", "T-044 clause A - stop_all on a QUEUE-BASED round (action_attack_start)", async () => {
      // Section 5's leash test deliberately walks the companion ~30 tiles chasing a relocated
      // biter, so by now it is both out of reach of `arena` AND at the edge of the radius-30 zone
      // findSafeArenaSpot verified clear of spawners/worms. Put it back on the verified spot, then
      // anchor on its LIVE position - re-anchoring alone would fix reach while silently giving up
      // the safety guarantee.
      const displaced = await companionPos(mcp, ID);
      await teleportCompanionToArena(rcon, displaced.x, displaced.y, arena.x, arena.y);
      const here6 = await companionPos(mcp, ID);
      const target = { x: here6.x, y: here6.y - 5 };
      const dTarget = dist(await companionPos(mcp, ID), target);
      check("6 setup: target point is within reach (10) of the companion", dTarget < REACH_LIMIT, `dist=${dTarget.toFixed(2)}`);

      const biters = await spawnBitersAt(rcon, [target]);
      check("6 setup: biter created", biters.length === 1 && biters[0]!.created, JSON.stringify(biters));
      if (!(biters.length === 1 && biters[0]!.created)) return;
      const biter = biters[0]!;
      spawnedUnitIds.push(biter.unit_number);

      const startRes = await callTool(mcp.client, "action_attack_start", { companionId: ID, x: target.x, y: target.y });
      console.log("action_attack_start (section 6) ->", JSON.stringify(startRes));
      check("6.1 setup: combat started ({started:true})", startRes?.started === true, JSON.stringify(startRes));
      if (startRes?.started !== true) {
        await destroySpawnedUnits(rcon, [biter.unit_number]);
        return;
      }

      const precondition = await waitForActiveShooting(mcp, rcon, ID, PRECONDITION_POLL_TIMEOUT_MS);
      console.log("6: precondition (active + shooting_enemies) ->", JSON.stringify(precondition));
      check("6.2 setup (PRECONDITION): round is active AND shooting_state == shooting_enemies before stop_all", precondition.active && precondition.shooting === "shooting_enemies", JSON.stringify(precondition));
      if (!(precondition.active && precondition.shooting === "shooting_enemies")) {
        console.log("6: precondition not met - returning early rather than scoring decisive assertions on a broken premise");
        await destroySpawnedUnits(rcon, [biter.unit_number]);
        return;
      }

      const stopAll = await callTool(mcp.client, "companion_stop_all", { companionId: ID });
      console.log("companion_stop_all (section 6) ->", JSON.stringify(stopAll));
      check("6.3 DECISIVE: reply's stopped list includes 'combat'", asArray<string>(stopAll?.stopped).includes("combat"), JSON.stringify(stopAll));

      const afterPos = await companionPos(mcp, ID);
      const afterState = await readEntityState(rcon, afterPos);
      console.log("Entity state after stop_all (section 6) ->", JSON.stringify(afterState));
      check("6.4 DECISIVE: shooting_state reads not_shooting off the entity (not from the reply)", afterState.shooting === "not_shooting", JSON.stringify(afterState));

      const status = await callTool(mcp.client, "action_attack_status", { companionId: ID });
      console.log("action_attack_status (after stop_all, section 6) ->", JSON.stringify(status));
      check("6.5 DECISIVE: terminal reason is 'stopped'", status?.status?.reason === "stopped", JSON.stringify(status));

      const cleanup = await destroySpawnedUnits(rcon, [biter.unit_number]);
      console.log("6: teardown ->", JSON.stringify(cleanup));
    });

    // ================================================================================
    await section("7", "T-044 clause B - stop_all on the QUEUE-LESS action_attack path (the 0.21.1 fix)", async () => {
      // Live position, not the arena constant - same reason as section 6 above.
      const here7 = await companionPos(mcp, ID);
      const aim = { x: here7.x - 3, y: here7.y + 3 };
      const biterPos = { x: aim.x + 0.6, y: aim.y };
      const dAim = dist(await companionPos(mcp, ID), aim);
      check("7 setup: aim point is within reach (10) of the companion", dAim < REACH_LIMIT, `dist=${dAim.toFixed(2)}`);

      const biters = await spawnBitersAt(rcon, [biterPos]);
      check("7 setup: biter created within radius 2 of the aim point", biters.length === 1 && biters[0]!.created, JSON.stringify(biters));
      if (!(biters.length === 1 && biters[0]!.created)) return;
      const biter = biters[0]!;
      spawnedUnitIds.push(biter.unit_number);

      const res = await callTool(mcp.client, "action_attack", { companionId: ID, x: aim.x, y: aim.y });
      console.log("action_attack (section 7, sync/queue-less) ->", JSON.stringify(res));
      check("7.1 setup: action_attack attacks (attacking:true)", res?.attacking === true, JSON.stringify(res));
      if (res?.attacking !== true) {
        await destroySpawnedUnits(rcon, [biter.unit_number]);
        return;
      }

      const pos7 = await companionPos(mcp, ID);
      const precondition = await readEntityState(rcon, pos7);
      console.log("7: precondition (shooting_state right after the synchronous attack) ->", JSON.stringify(precondition));
      check("7.2 setup (PRECONDITION): shooting_state == shooting_enemies immediately after action_attack, with NO queue behind it", precondition.shooting === "shooting_enemies", JSON.stringify(precondition));
      if (precondition.shooting !== "shooting_enemies") {
        console.log("7: precondition not met - returning early rather than scoring decisive assertions on a broken premise");
        await destroySpawnedUnits(rcon, [biter.unit_number]);
        return;
      }

      // Confirm there really is no queue for stop_all to find - action_attack_status should read
      // active:false the whole time, since fac_action_attack never creates a combat_queues entry.
      const statusCheck = await callTool(mcp.client, "action_attack_status", { companionId: ID });
      console.log("7: action_attack_status (confirming no queue exists) ->", JSON.stringify(statusCheck));
      check("7.3 setup: action_attack_status reads active:false (no queue - fac_action_attack never creates one)", statusCheck?.status?.active === false, JSON.stringify(statusCheck));

      const stopAll = await callTool(mcp.client, "companion_stop_all", { companionId: ID });
      console.log("companion_stop_all (section 7, the 0.21.1 fix) ->", JSON.stringify(stopAll));
      check("7.4 DECISIVE: reply's stopped list does NOT include 'combat' (no queue existed - response contract unchanged)", !asArray<string>(stopAll?.stopped).includes("combat"), JSON.stringify(stopAll));

      const afterPos = await companionPos(mcp, ID);
      const afterState = await readEntityState(rcon, afterPos);
      console.log("Entity state after stop_all (section 7, THE decisive assertion) ->", JSON.stringify(afterState));
      check("7.5 DECISIVE (the 0.21.1 fix itself): shooting_state reads not_shooting off the entity, even with no queue to stop", afterState.shooting === "not_shooting", JSON.stringify(afterState));

      const cleanup = await destroySpawnedUnits(rcon, [biter.unit_number]);
      console.log("7: teardown ->", JSON.stringify(cleanup));
    });
  } finally {
    console.log("\n--- Cleanup ---");
    try {
      await callToolSafe(mcp, "companion_stop_all", { companionId: ID });
    } catch (e) {
      console.log("Cleanup companion_stop_all failed (reporting, not hiding):", e);
    }

    if (spawnedUnitIds.length > 0) {
      try {
        const cleanup = await destroySpawnedUnits(rcon, spawnedUnitIds);
        console.log("Cleanup: final teardown of any surviving spawned unit(s) ->", JSON.stringify(cleanup));
      } catch (e) {
        console.log("Cleanup spawned-unit removal failed (reporting, not hiding):", e);
      }
    }

    for (const t of spawnedTreePositions) {
      try {
        const removed = await destroyNear(rcon, "tree-01", t, 0.5);
        console.log(`Cleanup: removed ${removed} distractor tree(s) near (${t.x}, ${t.y})`);
      } catch (e) {
        console.log("Cleanup tree removal failed (reporting, not hiding):", e);
      }
    }

    try {
      const lastPos = await companionPos(mcp, ID).catch(() => null);
      await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
      // disappear spills the companion's guns/ammo (spill_equipment) rather than destroying them -
      // clean that residue up so the world nets to zero items added by this suite.
      if (lastPos) {
        const swept = await sweepGround(rcon, lastPos, 15);
        console.log(`Cleanup: swept ${swept} item count(s) of spilled residue near the companion's last position`);
      }
    } catch (e) {
      console.log("Cleanup companion_disappear failed (reporting, not hiding):", e);
    }

    await mcp.close();
    await rcon.close();
  }

  process.exit(summary());
}

/** Best-effort tool call for cleanup paths - never throws, just logs. */
async function callToolSafe(mcp: { client: any }, name: string, args: Record<string, unknown>): Promise<void> {
  try {
    await callTool(mcp.client, name, args);
  } catch (e) {
    console.log(`callToolSafe(${name}) failed (reporting, not hiding):`, e);
  }
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
