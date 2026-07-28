// Live smoke test for T-030 (mod 0.21.0): reach/targeting parity residue across seven
// independent, previously-untested code paths. Each section is self-contained (its own
// absolute setup, its own teardown-relevant tracking) - unlike t042/t043 this suite does not
// chase one regression, it sweeps several small frozen contracts that had no live coverage yet.
//
// OUT OF SCOPE (do not attempt): the combat changes (fac_action_attack's weapon gate and target
// resolution, start_combat's reach bind, chase leash/stall, stop_all clearing shooting_state)
// cannot be verified on a headless server. With no client connected game.players[1] has no
// character, so companions spawn UNARMED (companion.lua's arm_from takes from the player's
// inventory, which requires a character) and every combat path short-circuits on the weapon
// gate immediately. This suite does not arm a companion over the side channel to force past
// that gate - doing so would prove the harness, not the mod (see CLAUDE.md's harness-sanctioned
// scope: spawning items/entities and teleporting is for arena SETUP, not for faking a
// precondition the mod itself is supposed to enforce).
//
// Sections (companion 30 primary, companion 31 bystander - fresh ids, not used elsewhere in
// this directory):
//   1. fac_item_pick (item.lua) - search radius is clamped to loot_pickup_distance (2)
//      regardless of a caller-requested radius; a found-but-marginally-outside item is
//      rejected per-item and counted in skipped_out_of_reach.
//   2. u.optional_position (init.lua, exercised via building_fill) - both coords empty acts at
//      the companion's own position; exactly one empty is a structured refusal, not a silent
//      fallback.
//   3. fac_resource_list (resource.lua) - returns real results, filters correctly (ore by name,
//      wood by type, omitting `amount`), and honours radius.
//   4. fac_companion_inventory's x/y branch (companion.lua) - resolves the NEAREST container
//      and excludes characters via resolve_target's default allow_characters=false, even
//      though defines.inventory.chest == character_main == 1 would otherwise make a bystander
//      companion satisfy the container predicate.
//   5. fac_building_can_place (building.lua) - a reach failure carries can_place=false
//      ADDITIVELY alongside the full check_reach error shape (not instead of it).
//   6. fac_companion_list (companion.lua) - prunes a dead record from storage, proven via
//      /fac_context_clear all's raw `companions` array (context.lua), which storage.companions
//      genuinely reflects (unlike /silent-command, which cannot see mod storage at all).
//   7. fac_companion_stop_all / queues.stop_build (T-049) - stopping an in-flight async build
//      records {reason:"stopped", entity:<this run's entity>, placed:false} rather than
//      leaking a prior run's result or silently dropping the queue.
//
// Prefer the disposable headless server, which guarantees fresh mod code:
//   bun run scripts/smoke/test-server.ts t030
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t030-parity-residue.ts
import { connectMCP, connectRCON, callTool, check, summary, silent } from "./lib";
import { asArray } from "../../src/utils/connection";

const ID = 30;
const BYSTANDER = 31;
const POLL_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 200;

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

/** /fac_companion_position is a real mod command (unlike /silent-command it CAN see storage). */
async function companionPos(rcon: RCON, id: number): Promise<Pos> {
  const raw = await rcon.send(`/fac_companion_position ${id}`);
  const d = JSON.parse(raw.split("\n").find((l) => l.trim().startsWith("{"))!);
  if (!d?.position) throw new Error(`companion ${id} has no position: ${raw}`);
  return d.position;
}

async function invCount(rcon: RCON, id: number, item: string): Promise<number> {
  const raw = await rcon.send(`/fac_companion_inventory ${id}`);
  const d = JSON.parse(raw.split("\n").find((l) => l.trim().startsWith("{"))!);
  const items = Array.isArray(d?.items) ? d.items : [];
  return items.find((i: any) => i.name === item)?.count ?? 0;
}

/** storage.companions is unreachable from /silent-command, so companions are identified by
 *  matching a character with no player near their LAST KNOWN position (from the real command
 *  above). Scoped per-id since two companions are alive at once in section 4. */
function nearestCompanionLua(pos: Pos, varName = "best"): string {
  return `
    local ${varName}, ${varName}d
    for _, e in pairs(game.surfaces[1].find_entities_filtered{type = "character", position = {x=${pos.x}, y=${pos.y}}, radius = 3}) do
      if e.player == nil then
        local d = (e.position.x - ${pos.x})^2 + (e.position.y - ${pos.y})^2
        if not ${varName}d or d < ${varName}d then ${varName}d, ${varName} = d, e end
      end
    end
  `;
}

async function teleportCompanion(rcon: RCON, id: number, x: number, y: number): Promise<boolean> {
  const cur = await companionPos(rcon, id);
  const r = await lua(rcon, `
    ${nearestCompanionLua(cur)}
    if not best then rcon.print(helpers.table_to_json({teleported = false, error = "companion not found"})) return end
    local ok = best.teleport({${x}, ${y}})
    rcon.print(helpers.table_to_json({teleported = ok}))
  `);
  return r.teleported === true;
}

/** Sanctioned in harnesses only (T-019/T-037/T-042/T-043 precedent). Sets the companion's
 *  main-inventory count of ONE item to exactly `count`, removing whatever it already held
 *  first, so every section resets to an ABSOLUTE state rather than a relative one. */
async function setCompanionItems(rcon: RCON, id: number, name: string, count: number): Promise<number> {
  const cur = await companionPos(rcon, id);
  const r = await lua(rcon, `
    ${nearestCompanionLua(cur)}
    if not best then rcon.print(helpers.table_to_json({ok = false})) return end
    local inv = best.get_inventory(defines.inventory.character_main)
    local held = inv.get_item_count("${name}")
    if held > 0 then inv.remove{name = "${name}", count = held} end
    if ${count} > 0 then inv.insert{name = "${name}", count = ${count}} end
    rcon.print(helpers.table_to_json({ok = true, have = inv.get_item_count("${name}")}))
  `);
  if (!r.ok) throw new Error(`could not locate companion ${id} to set items`);
  return r.have;
}

/** Creates an arena entity via the player's force (matches c.entity.force in the Lua handlers'
 *  own filters). Returns the ENGINE's actual (possibly snapped) position, not the request. */
async function createEntity(rcon: RCON, name: string, pos: Pos, direction?: number): Promise<{ created: boolean; x: number; y: number; unit_number?: number }> {
  const dirClause = direction !== undefined ? `, direction = ${direction}` : "";
  return lua(rcon, `
    local e = game.players[1].surface.create_entity{name = "${name}", position = {x=${pos.x}, y=${pos.y}}, force = game.players[1].force${dirClause}}
    if not e or not e.valid then rcon.print(helpers.table_to_json({created = false})) return end
    rcon.print(helpers.table_to_json({created = true, x = e.position.x, y = e.position.y, unit_number = e.unit_number}))
  `);
}

/** item-on-ground has no owning force - a plain create_entity{stack=...} is the right shape
 *  (mirrors item.lua's own item-entity handling). */
async function createGroundItem(rcon: RCON, pos: Pos, name: string, count: number): Promise<{ created: boolean; x: number; y: number }> {
  return lua(rcon, `
    local e = game.surfaces[1].create_entity{name = "item-on-ground", position = {x=${pos.x}, y=${pos.y}}, stack = {name = "${name}", count = ${count}}}
    if not e or not e.valid then rcon.print(helpers.table_to_json({created = false})) return end
    rcon.print(helpers.table_to_json({created = true, x = e.position.x, y = e.position.y}))
  `);
}

/** Sums stack counts (never entity counts - a stack can split) of item-on-ground entities
 *  matching `name` within radius of pos, WITHOUT destroying them - proves a far stack was
 *  left untouched by a reach-bound pick attempt. */
async function groundStackCount(rcon: RCON, pos: Pos, radius: number, name: string): Promise<number> {
  const r = await lua(rcon, `
    local n = 0
    for _, e in pairs(game.surfaces[1].find_entities_filtered{position = {x=${pos.x}, y=${pos.y}}, radius = ${radius}, name = "item-on-ground"}) do
      if e.valid and e.stack and e.stack.valid_for_read and e.stack.name == "${name}" then n = n + e.stack.count end
    end
    rcon.print(helpers.table_to_json({n = n}))
  `);
  return r.n;
}

async function destroyNear(rcon: RCON, name: string, pos: Pos, radius = 1): Promise<number> {
  const r = await lua(rcon, `
    local n = 0
    for _, e in pairs(game.surfaces[1].find_entities_filtered{name = "${name}", position = {x=${pos.x}, y=${pos.y}}, radius = ${radius}}) do
      if e.valid then e.destroy() n = n + 1 end
    end
    rcon.print(helpers.table_to_json({n = n}))
  `);
  return r.n;
}

async function countNear(rcon: RCON, name: string, pos: Pos, radius: number): Promise<number> {
  const r = await lua(rcon, `
    rcon.print(helpers.table_to_json({n = #game.surfaces[1].find_entities_filtered{name = "${name}", position = {x=${pos.x}, y=${pos.y}}, radius = ${radius}}}))
  `);
  return r.n;
}

async function chestInvCount(rcon: RCON, name: string, pos: Pos, item: string): Promise<number> {
  const r = await lua(rcon, `
    local es = game.surfaces[1].find_entities_filtered{name = "${name}", position = {x=${pos.x}, y=${pos.y}}, radius = 0.6}
    if #es == 0 then rcon.print(helpers.table_to_json({found = false})) return end
    rcon.print(helpers.table_to_json({found = true, count = es[1].get_inventory(defines.inventory.chest).get_item_count("${item}")}))
  `);
  if (!r.found) throw new Error(`${name} not found near ${JSON.stringify(pos)}`);
  return r.count;
}

async function insertIntoChest(rcon: RCON, name: string, pos: Pos, item: string, count: number): Promise<number> {
  const r = await lua(rcon, `
    local es = game.surfaces[1].find_entities_filtered{name = "${name}", position = {x=${pos.x}, y=${pos.y}}, radius = 0.6}
    if #es == 0 then rcon.print(helpers.table_to_json({found = false})) return end
    rcon.print(helpers.table_to_json({found = true, inserted = es[1].get_inventory(defines.inventory.chest).insert{name = "${item}", count = ${count}}}))
  `);
  if (!r.found) throw new Error(`${name} not found near ${JSON.stringify(pos)}`);
  return r.inserted;
}

/** Harness-sanctioned direct gift (T-019/T-037 precedent) - used only to give the bystander
 *  companion a distinguishing item in section 4, never to arm anyone for combat. */
async function giveCompanionItems(rcon: RCON, id: number, name: string, count: number): Promise<number> {
  const cur = await companionPos(rcon, id);
  const r = await lua(rcon, `
    ${nearestCompanionLua(cur)}
    if not best then rcon.print(helpers.table_to_json({ok = false})) return end
    local ins = best.get_inventory(defines.inventory.character_main).insert{name = "${name}", count = ${count}}
    rcon.print(helpers.table_to_json({ok = true, inserted = ins}))
  `);
  if (!r.ok) throw new Error(`could not locate companion ${id} to give items`);
  return r.inserted;
}

/** Spilled stacks split across several item-entity entities, so sum COUNTS per name, never
 *  entity counts (disappear spills with enable_looted = true). */
async function sweepGround(rcon: RCON, at: Pos, radius = 10): Promise<number> {
  const r = await lua(rcon, `
    local n = 0
    for _, e in pairs(game.surfaces[1].find_entities_filtered{position = {x=${at.x}, y=${at.y}}, radius = ${radius}, name = "item-on-ground"}) do
      if e.valid then n = n + (e.stack and e.stack.valid_for_read and e.stack.count or 0) e.destroy() end
    end
    rcon.print(helpers.table_to_json({swept = n}))
  `);
  return r.swept;
}

/** A spot with no non-resource/tree entity within `radius` - so a small arena's own search
 *  can't accidentally pick up something pre-existing in the world. */
async function findClearSpot(rcon: RCON, candidates: Pos[], radius: number): Promise<Pos> {
  for (const p of candidates) {
    const r = await lua(rcon, `
      local n = 0
      for _, e in pairs(game.surfaces[1].find_entities_filtered{position = {x=${p.x}, y=${p.y}}, radius = ${radius}}) do
        if e.type ~= "resource" and e.type ~= "tree" and e.type ~= "cliff" and e.type ~= "fish" then n = n + 1 end
      end
      rcon.print(helpers.table_to_json({n = n}))
    `);
    if (r.n === 0) return p;
  }
  throw new Error(`no clear spot found among ${candidates.length} candidates (radius ${radius})`);
}

/** Polls building_place_status until the queue resolves (status.active === false) or the
 *  timeout elapses. Returns the LAST status seen either way. */
async function pollBuildStatus(mcp: { client: any }, id: number): Promise<any> {
  const start = Date.now();
  let status: any;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await callTool(mcp.client, "building_place_status", { companionId: id });
    status = res?.status;
    if (status && status.active === false) return status;
    await sleep(POLL_INTERVAL_MS);
  }
  return status;
}

async function section(label: string, banner: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  await body();
}

async function main(): Promise<void> {
  const mcp = await connectMCP();
  const rcon = await connectRCON();
  const placed: { name: string; x: number; y: number }[] = [];

  try {
    console.log("=== Setup: spawn companion 30 (primary) ===");
    await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
    await callTool(mcp.client, "companion_disappear", { companionId: BYSTANDER }).catch(() => {});
    const spawn = await callTool(mcp.client, "companion_spawn", { companionId: ID });
    console.log("companion_spawn(30) ->", JSON.stringify(spawn));
    check("setup: companion 30 spawned (not a stale 'exists')", spawn?.spawned === true, JSON.stringify(spawn));
    if (spawn?.spawned !== true) throw new Error("cannot proceed without a fresh companion");

    const spawnPos = await companionPos(rcon, ID);
    const base = await findClearSpot(
      rcon,
      [
        spawnPos,
        { x: spawnPos.x + 40, y: spawnPos.y },
        { x: spawnPos.x - 40, y: spawnPos.y },
        { x: spawnPos.x, y: spawnPos.y + 40 },
        { x: spawnPos.x, y: spawnPos.y - 40 },
        { x: spawnPos.x + 60, y: spawnPos.y + 60 }
      ],
      20
    );
    console.log("Base arena anchor ->", JSON.stringify(base));

    // ================================================================================
    await section("1", "fac_item_pick: search radius clamped to loot_pickup_distance (2), not the caller's requested radius", async () => {
      const arena = { x: base.x, y: base.y };
      await teleportCompanion(rcon, ID, arena.x, arena.y);
      const at = await companionPos(rcon, ID);

      await setCompanionItems(rcon, ID, "iron-plate", 0);
      const before = await invCount(rcon, ID, "iron-plate");
      check("1 setup: companion's iron-plate reset to 0 (absolute)", before === 0, `have=${before}`);
      if (before !== 0) return;

      const nearPos = { x: arena.x + 1.5, y: arena.y };
      const diagPos = { x: arena.x + 1.6, y: arena.y + 1.6 };
      const farPos = { x: arena.x + 6, y: arena.y };
      const dNear = dist(at, nearPos);
      const dDiag = dist(at, diagPos);
      const dFar = dist(at, farPos);
      check("1 setup: near item is within loot_pickup_distance (2)", dNear < 2, `dist=${dNear.toFixed(3)}`);
      check("1 setup: diagonal item is OUTSIDE the true circular reach (2) but within a 45deg bounding-box radius", dDiag > 2, `dist=${dDiag.toFixed(3)}`);
      check("1 setup: cardinal far item is well outside reach", dFar > 2, `dist=${dFar.toFixed(3)}`);
      if (!(dNear < 2 && dDiag > 2 && dFar > 2)) return;

      const near = await createGroundItem(rcon, nearPos, "iron-plate", 3);
      const diag = await createGroundItem(rcon, diagPos, "iron-plate", 4);
      const far = await createGroundItem(rcon, farPos, "iron-plate", 5);
      check("1 setup: all three ground stacks created", near.created && diag.created && far.created, `near=${JSON.stringify(near)} diag=${JSON.stringify(diag)} far=${JSON.stringify(far)}`);
      if (!(near.created && diag.created && far.created)) return;
      placed.push({ name: "item-on-ground", x: near.x, y: near.y });
      placed.push({ name: "item-on-ground", x: diag.x, y: diag.y });
      placed.push({ name: "item-on-ground", x: far.x, y: far.y });

      // radius = 1000: a huge caller-requested radius must NOT widen the search past reach.
      const pick = await callTool(mcp.client, "item_pick", { companionId: ID, itemName: "iron-plate", radius: 1000 });
      console.log("item_pick(radius=1000) ->", JSON.stringify(pick));
      const pickedList = asArray<{ name: string; count: number }>(pick?.picked);
      const pickedTotal = pickedList.filter((p) => p.name === "iron-plate").reduce((s, p) => s + p.count, 0);

      check("1.1 DECISIVE: only the near item's count (3) was ever picked, despite radius=1000", pickedTotal === 3, `pickedTotal=${pickedTotal} picked=${JSON.stringify(pickedList)}`);
      const afterInv = await invCount(rcon, ID, "iron-plate");
      check("1.2 DECISIVE: main inventory gained exactly 3 (the near item's count)", afterInv === 3, `have=${afterInv}`);

      const diagGround = await groundStackCount(rcon, diagPos, 0.6, "iron-plate");
      const farGround = await groundStackCount(rcon, farPos, 0.6, "iron-plate");
      check("1.3 DECISIVE: the diagonal item's ground count is unchanged (never picked, radius=1000 notwithstanding)", diagGround === 4, `count=${diagGround}`);
      check("1.4 DECISIVE: the far cardinal item's ground count is unchanged (found by the search, refused by the per-item reach gate)", farGround === 5, `count=${farGround}`);

      // Decisive, not informational. The search is capped at ITEM_SEARCH_MAX_RADIUS (50), NOT at
      // the reach limit, precisely so this counter is meaningful: both the diagonal (2.26) and
      // the cardinal (6) item enter the candidate set and are then refused by the per-item
      // circular check_reach. A 0 here would mean the search had been re-clamped to reach and
      // the counter was structurally dead again - which is exactly the regression this asserts
      // against, and what "walk closer" vs "nothing here" depends on.
      const skipped = pick?.skipped_out_of_reach;
      check("1.5 DECISIVE: skipped_out_of_reach counts BOTH out-of-reach items (2), so the caller can tell 'walk closer' from 'nothing here'", skipped === 2, `skipped_out_of_reach=${skipped}`);
    });

    // ================================================================================
    await section("2", "u.optional_position (exercised via building_fill): both-empty / one-empty / both-present", async () => {
      const arena = { x: base.x + 30, y: base.y };
      const chestPos = { x: arena.x + 2, y: arena.y };
      const nearChestPos = { x: arena.x, y: arena.y };

      const chest = await createEntity(rcon, "wooden-chest", chestPos);
      check("2 setup: wooden-chest placed", chest.created, JSON.stringify(chest));
      if (!chest.created) return;
      placed.push({ name: "wooden-chest", x: chest.x, y: chest.y });

      // --- Case 1: both x and y supplied, at the chest's coordinates -> succeeds there. ---
      await teleportCompanion(rcon, ID, nearChestPos.x, nearChestPos.y);
      await setCompanionItems(rcon, ID, "stone", 20);
      let stoneNow = await invCount(rcon, ID, "stone");
      check("2.1 setup: companion holds 20 stone", stoneNow === 20, `have=${stoneNow}`);
      if (stoneNow !== 20) return;

      const case1 = await callTool(mcp.client, "building_fill", { companionId: ID, itemName: "stone", count: 5, x: chest.x, y: chest.y });
      console.log("building_fill(both x&y, at chest) ->", JSON.stringify(case1));
      check("2.1: fill succeeds when both coordinates are supplied", case1?.inserted === 5, JSON.stringify(case1));
      check("2.1: reply names the resolved entity (wooden-chest)", case1?.entity === "wooden-chest", JSON.stringify(case1));

      const chestStoneAfter1 = await chestInvCount(rcon, "wooden-chest", chest, "stone");
      check("2.1 DECISIVE: the chest actually gained the item (0 -> 5)", chestStoneAfter1 === 5, `chest stone=${chestStoneAfter1}`);
      const companionStoneAfter1 = await invCount(rcon, ID, "stone");
      check("2.1 DECISIVE: companion inventory dropped by exactly 5 (20 -> 15)", companionStoneAfter1 === 15, `have=${companionStoneAfter1}`);

      // --- Case 2: neither x nor y supplied -> acts at the companion's OWN position, which
      // (deliberately) has no container in range, so it fails for a DIFFERENT, unsurprising
      // reason than case 3's "Incomplete position". ---
      const clearSpot = await findClearSpot(rcon, [
        { x: arena.x + 40, y: arena.y },
        { x: arena.x - 40, y: arena.y },
        { x: arena.x, y: arena.y + 40 }
      ], 6);
      await teleportCompanion(rcon, ID, clearSpot.x, clearSpot.y);
      await setCompanionItems(rcon, ID, "stone", 20);
      stoneNow = await invCount(rcon, ID, "stone");
      check("2.2 setup: companion reset to 20 stone at a spot with no container nearby", stoneNow === 20, `have=${stoneNow}`);
      if (stoneNow !== 20) return;

      const case2 = await callTool(mcp.client, "building_fill", { companionId: ID, itemName: "stone", count: 5 });
      console.log("building_fill(no x/y at all) ->", JSON.stringify(case2));
      check("2.2: acts at the companion's own position and fails there (no container) - NOT a success at the chest", case2?.error === "No container with an input inventory found" && case2?.inserted === undefined, JSON.stringify(case2));

      const chestStoneAfter2 = await chestInvCount(rcon, "wooden-chest", chest, "stone");
      check("2.2 DECISIVE: the (distant) chest is untouched", chestStoneAfter2 === 5, `chest stone=${chestStoneAfter2}`);
      const companionStoneAfter2 = await invCount(rcon, ID, "stone");
      check("2.2 DECISIVE: companion inventory unchanged (still 20)", companionStoneAfter2 === 20, `have=${companionStoneAfter2}`);

      // --- Case 3 (DECISIVE): exactly one of x/y supplied. Companion is positioned NEAR the
      // chest (unlike case 2) so that a regression to the old silent fallback - "one coordinate
      // missing quietly substitutes the companion's own position" - would SUCCEED at the chest
      // instead of erroring, making the bug maximally visible rather than accidentally
      // producing the same refusal text as case 2. ---
      await teleportCompanion(rcon, ID, nearChestPos.x, nearChestPos.y);
      await setCompanionItems(rcon, ID, "stone", 20);
      stoneNow = await invCount(rcon, ID, "stone");
      check("2.3 setup: companion reset to 20 stone, positioned NEAR the chest again", stoneNow === 20, `have=${stoneNow}`);
      if (stoneNow !== 20) return;

      // Omit the `y` key entirely (not y: undefined) so buildRCONCommand's template
      // substitution renders a genuinely empty slot, per src/mcp/tools.ts's own replacer.
      const case3args: Record<string, unknown> = { companionId: ID, itemName: "stone", count: 5, x: chest.x };
      let case3 = await callTool(mcp.client, "building_fill", case3args);
      console.log("building_fill(x only, via MCP) ->", JSON.stringify(case3));
      if (case3?.error !== "Incomplete position: need both x and y") {
        // Fallback per the frozen spec: drive the same asymmetric shape over raw RCON if the
        // MCP path didn't reach it.
        console.log("MCP path did not reach 'Incomplete position' - falling back to raw RCON single-coordinate command");
        const raw = await rcon.send(`/fac_building_fill ${ID} stone 5 ${chest.x}`);
        const line = raw.split("\n").find((l) => l.trim().startsWith("{"));
        case3 = line ? JSON.parse(line) : { error: "no JSON in RCON reply", raw };
        console.log("building_fill(x only, via raw RCON) ->", JSON.stringify(case3));
      }
      check("2.3 DECISIVE: exactly one coordinate supplied is a structured refusal, not a silent success at the companion's feet (which are near the chest)", case3?.error === "Incomplete position: need both x and y", JSON.stringify(case3));

      const chestStoneAfter3 = await chestInvCount(rcon, "wooden-chest", chest, "stone");
      check("2.3 DECISIVE: the chest is unchanged (still 5) - a regression would have silently added to it", chestStoneAfter3 === 5, `chest stone=${chestStoneAfter3}`);
      const companionStoneAfter3 = await invCount(rcon, ID, "stone");
      check("2.3 DECISIVE: companion inventory is unchanged (still 20) - a regression would have silently spent from it", companionStoneAfter3 === 20, `have=${companionStoneAfter3}`);

      console.log("NOTE: building_empty shares the identical optional_position code path; repeating these 3 cases against it was cut for scope. building_fill's 3 cases above are authoritative for this contract.");
    });

    // ================================================================================
    await section("3", "fac_resource_list: real results, correct filtering, radius honoured", async () => {
      await teleportCompanion(rcon, ID, spawnPos.x, spawnPos.y);

      const unfiltered = await callTool(mcp.client, "resource_list", { companionId: ID, radius: 100, filter: "" });
      const unfilteredList = asArray<{ name: string; distance: number; amount?: number }>(unfiltered?.resources);
      console.log("resource_list(unfiltered, radius=100) -> count=", unfiltered?.count, "sample=", JSON.stringify(unfilteredList.slice(0, 3)));
      check("3.1: count > 0 and resources non-empty", typeof unfiltered?.count === "number" && unfiltered.count > 0 && unfilteredList.length > 0, `count=${unfiltered?.count}`);
      if (unfilteredList.length === 0) { console.log("3: aborting - no resource found within radius 100 of spawn, cannot proceed with the rest of this section"); return; }

      const discoveredName = unfilteredList[0]!.name;
      const filtered = await callTool(mcp.client, "resource_list", { companionId: ID, radius: 100, filter: discoveredName });
      const filteredList = asArray<{ name: string }>(filtered?.resources);
      console.log(`resource_list(filter=${discoveredName}) -> count=`, filtered?.count);
      check(`3.2 DECISIVE: every returned entry's name equals the filter (${discoveredName})`, filteredList.length > 0 && filteredList.every((r) => r.name === discoveredName), JSON.stringify(filteredList.map((r) => r.name)));

      const wood = await callTool(mcp.client, "resource_list", { companionId: ID, radius: 300, filter: "wood" });
      const woodList = asArray<{ name: string; amount?: number }>(wood?.resources);
      console.log("resource_list(filter=wood, radius=300) -> count=", wood?.count);
      if (woodList.length > 0) {
        check("3.3 DECISIVE: wood/tree entries omit `amount` (resource-only property)", woodList.every((r) => r.amount === undefined), JSON.stringify(woodList.slice(0, 5)));
      } else {
        check("3.3: no trees found within radius 300 of spawn - reporting rather than forcing a pass", true, "count=0, see log");
      }

      const small = await callTool(mcp.client, "resource_list", { companionId: ID, radius: 10, filter: "" });
      const large = await callTool(mcp.client, "resource_list", { companionId: ID, radius: 100, filter: "" });
      const smallList = asArray<{ distance: number }>(small?.resources);
      const largeList = asArray<{ distance: number }>(large?.resources);
      console.log("resource_list radius=10 count=", small?.count, "radius=100 count=", large?.count);
      check("3.4 DECISIVE: small-radius count <= large-radius count", smallList.length <= largeList.length, `small=${smallList.length} large=${largeList.length}`);
      check("3.4 DECISIVE: every small-radius entry's own reported distance is <= 10", smallList.every((r) => r.distance <= 10), JSON.stringify(smallList.map((r) => r.distance)));
    });

    // ================================================================================
    await section("4", "fac_companion_inventory x/y branch: nearest container, excludes characters", async () => {
      // Both chest prototypes are 1x1 (odd both dimensions), so create_entity centres them on
      // the nearest tile centre (integer + .5) - requesting anything else silently snaps and
      // can push a carefully-measured distance across the radius-2 threshold (caught live: a
      // requested offset of 1.8 tiles landed the entity 0.5 tiles further out, at distance
      // 2.27, outside resolve_target's search radius). Anchoring the query point itself on a
      // tile centre and using INTEGER offsets keeps every request already legal, so nothing
      // snaps and the measured distances are exact.
      const arena = { x: Math.floor(base.x + 60) + 0.5, y: Math.floor(base.y) + 0.5 };
      const query = { x: arena.x, y: arena.y };
      await teleportCompanion(rcon, ID, query.x, query.y);
      const spawnBystander = await callTool(mcp.client, "companion_spawn", { companionId: BYSTANDER });
      check("4 setup: bystander companion 31 spawned fresh", spawnBystander?.spawned === true, JSON.stringify(spawnBystander));
      if (spawnBystander?.spawned !== true) return;
      await giveCompanionItems(rcon, BYSTANDER, "copper-ore", 5); // distinguishing item, so a mis-resolved reply would be visibly wrong

      const woodenPos = { x: query.x + 1, y: query.y };
      const ironPos = { x: query.x + 1, y: query.y + 1 };
      const wooden = await createEntity(rcon, "wooden-chest", woodenPos);
      const iron = await createEntity(rcon, "iron-chest", ironPos);
      check("4 setup: both containers placed", wooden.created && iron.created, `wooden=${JSON.stringify(wooden)} iron=${JSON.stringify(iron)}`);
      if (!(wooden.created && iron.created)) return;
      placed.push({ name: "wooden-chest", x: wooden.x, y: wooden.y });
      placed.push({ name: "iron-chest", x: iron.x, y: iron.y });

      const dWooden = dist(query, wooden);
      const dIron = dist(query, iron);
      check("4 setup: wooden-chest is nearer the query point than iron-chest, both within resolve_target's radius (2)", dWooden < dIron && dWooden < 2 && dIron < 2, `wooden=${dWooden.toFixed(2)} iron=${dIron.toFixed(2)}`);
      if (!(dWooden < dIron && dWooden < 2 && dIron < 2)) return;

      const insWooden = await insertIntoChest(rcon, "wooden-chest", wooden, "iron-plate", 7);
      const insIron = await insertIntoChest(rcon, "iron-chest", iron, "copper-plate", 9);
      check("4 setup: wooden-chest holds 7 iron-plate, iron-chest holds 9 copper-plate", insWooden === 7 && insIron === 9, `wooden ins=${insWooden} iron ins=${insIron}`);
      if (!(insWooden === 7 && insIron === 9)) return;

      const q1 = await callTool(mcp.client, "companion_inventory", { companionId: ID, x: query.x, y: query.y });
      console.log("companion_inventory(query point, containers only) ->", JSON.stringify(q1));
      check("4.1 DECISIVE: resolves the NEARER container (wooden-chest)", q1?.entity === "wooden-chest", JSON.stringify(q1));
      const items1 = asArray<{ name: string; count: number }>(q1?.items);
      check("4.2 DECISIVE: reply's items are the wooden-chest's contents, not the iron-chest's", items1.some((i) => i.name === "iron-plate" && i.count === 7) && !items1.some((i) => i.name === "copper-plate"), JSON.stringify(items1));
      check("4.3 DECISIVE: iron-plate is listed exactly ONCE (chest/fuel index aliasing deduped)", items1.filter((i) => i.name === "iron-plate").length === 1, JSON.stringify(items1));

      // DECISIVE: bystander closer than either container. defines.inventory.chest ==
      // character_main == 1, so without resolve_target's allow_characters=false exclusion the
      // bystander's own inventory would satisfy the predicate and resolve as "the chest".
      const bystanderPos = { x: query.x - 0.4, y: query.y };
      await teleportCompanion(rcon, BYSTANDER, bystanderPos.x, bystanderPos.y);
      const dBystander = dist(query, bystanderPos);
      check("4 setup: bystander is CLOSER to the query point than either container", dBystander < dWooden && dBystander < dIron, `bystander=${dBystander.toFixed(2)} wooden=${dWooden.toFixed(2)} iron=${dIron.toFixed(2)}`);
      if (!(dBystander < dWooden && dBystander < dIron)) return;

      const q2 = await callTool(mcp.client, "companion_inventory", { companionId: ID, x: query.x, y: query.y });
      console.log("companion_inventory(query point, bystander now closer) ->", JSON.stringify(q2));
      check("4.4 DECISIVE: STILL resolves the wooden-chest, not the closer bystander character", q2?.entity === "wooden-chest", JSON.stringify(q2));
      const items2 = asArray<{ name: string; count: number }>(q2?.items);
      check("4.5 DECISIVE: items still match the chest's known stock (iron-plate=7), not the bystander's copper-ore", items2.some((i) => i.name === "iron-plate" && i.count === 7) && !items2.some((i) => i.name === "copper-ore"), JSON.stringify(items2));
    });

    // ================================================================================
    await section("5", "fac_building_can_place: a reach failure carries can_place=false ADDITIVELY, not instead of the reach error", async () => {
      const arena = { x: base.x + 90, y: base.y };
      await teleportCompanion(rcon, ID, arena.x, arena.y);
      const farPoint = { x: arena.x + 20, y: arena.y };
      const companionAt = await companionPos(rcon, ID);
      check("5 setup: target point is genuinely > 10 tiles from the companion", dist(companionAt, farPoint) > 10, `dist=${dist(companionAt, farPoint).toFixed(2)}`);

      const res = await callTool(mcp.client, "building_can_place", { companionId: ID, entityName: "stone-furnace", x: farPoint.x, y: farPoint.y });
      console.log("building_can_place(far) ->", JSON.stringify(res));
      check("5.1 DECISIVE: can_place === false", res?.can_place === false, JSON.stringify(res));
      check("5.2 DECISIVE: error === 'Too far'", res?.error === "Too far", JSON.stringify(res));
      check("5.3 DECISIVE: distance is a number", typeof res?.distance === "number", JSON.stringify(res));
      check("5.4 DECISIVE: reach is a number", typeof res?.reach === "number", JSON.stringify(res));
      check("5.5 DECISIVE: target is present", res?.target !== undefined && res?.target !== null, JSON.stringify(res));
    });

    // ================================================================================
    await section("6", "fac_companion_list prunes dead records from storage.companions, not just its own reply", async () => {
      // Companion 30 is already alive from setup - re-verify it's the one this section expects.
      const list1 = await callTool(mcp.client, "companion_list", {});
      const list1Ids = asArray<{ id: number }>(list1?.companions).map((c) => c.id);
      check("6.1: companion_list includes id 30", list1Ids.includes(30), JSON.stringify(list1Ids));

      // /fac_context_clear all (context.lua) returns the RAW keys of storage.companions with no
      // validity check at all - this is the side-channel-equivalent of reading mod storage
      // directly, since /silent-command genuinely cannot see it. NOTE the global side effect:
      // this wipes storage.companion_messages and stamps a context-clear-request tick for every
      // companion currently alive - acceptable here since this is the last thing this suite
      // does with companion 30's message state, but noted per CLAUDE.md.
      const clear1Raw = await rcon.send("/fac_context_clear all");
      const clear1 = JSON.parse(clear1Raw.split("\n").find((l) => l.trim().startsWith("{"))!);
      const clear1Ids = asArray<number>(clear1?.companions);
      console.log("/fac_context_clear all (before disappear) ->", JSON.stringify(clear1));
      check("6.2 DECISIVE: storage.companions genuinely contains 30 (not just companion_list's own claim)", clear1Ids.includes(30), JSON.stringify(clear1Ids));

      const disappear = await callTool(mcp.client, "companion_disappear", { companionId: ID });
      console.log("companion_disappear(30) ->", JSON.stringify(disappear));
      check("6.3: companion_disappear(30) succeeded", disappear?.disappeared === true, JSON.stringify(disappear));

      const list2 = await callTool(mcp.client, "companion_list", {});
      const list2Ids = asArray<{ id: number }>(list2?.companions).map((c) => c.id);
      check("6.4: companion_list no longer includes id 30", !list2Ids.includes(30), JSON.stringify(list2Ids));

      const clear2Raw = await rcon.send("/fac_context_clear all");
      const clear2 = JSON.parse(clear2Raw.split("\n").find((l) => l.trim().startsWith("{"))!);
      const clear2Ids = asArray<number>(clear2?.companions);
      console.log("/fac_context_clear all (after disappear) ->", JSON.stringify(clear2));
      check("6.5 DECISIVE: storage.companions no longer contains 30 (the storage record was actually dropped, not merely hidden from companion_list's reply)", !clear2Ids.includes(30), JSON.stringify(clear2Ids));
    });

    // ================================================================================
    await section("7", "fac_companion_stop_all / queues.stop_build (T-049): records THIS run's build result, not a leaked prior one", async () => {
      const arena = { x: base.x + 120, y: base.y };
      const pointA = { x: arena.x + 3, y: arena.y };
      const pointB = { x: arena.x - 3, y: arena.y };

      const spawn = await callTool(mcp.client, "companion_spawn", { companionId: ID }).catch(async () => {
        await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
        return callTool(mcp.client, "companion_spawn", { companionId: ID });
      });
      console.log("companion_spawn(30, for section 7) ->", JSON.stringify(spawn));
      check("7 setup: companion 30 spawned fresh for this section", spawn?.spawned === true, JSON.stringify(spawn));
      if (spawn?.spawned !== true) return;
      await teleportCompanion(rcon, ID, arena.x, arena.y);

      // Step 1: seed a DIFFERENT, distinguishable completed result first, so the assertions
      // below prove THIS run's result rather than passing vacuously on start_build's own
      // storage.build_results[cid] = nil clear.
      await setCompanionItems(rcon, ID, "stone-furnace", 1);
      let have = await invCount(rcon, ID, "stone-furnace");
      check("7.0 setup: companion holds exactly 1 stone-furnace", have === 1, `have=${have}`);
      if (have !== 1) return;

      const seedStart = await callTool(mcp.client, "building_place_start", { companionId: ID, entityName: "stone-furnace", x: pointA.x, y: pointA.y, direction: 0 });
      console.log("building_place_start(seed, stone-furnace @ A) ->", JSON.stringify(seedStart));
      check("7.0: seed queue accepted", seedStart?.started === true, JSON.stringify(seedStart));
      if (seedStart?.started !== true) return;

      const seedStatus = await pollBuildStatus(mcp, ID);
      console.log("building_place_status(seed, resolved) ->", JSON.stringify(seedStatus));
      check("7.0 DECISIVE: seed build resolved as placed (stone-furnace)", seedStatus?.active === false && seedStatus?.placed === true && seedStatus?.reason === "placed" && seedStatus?.entity === "stone-furnace", JSON.stringify(seedStatus));
      if (seedStatus?.placed === true && seedStatus?.position) {
        const removed = await destroyNear(rcon, "stone-furnace", seedStatus.position, 1);
        check("7.0 cleanup: seed furnace removed before the real test runs", removed === 1, `removed=${removed}`);
      }

      // Step 2-3: start a NEW build with a DIFFERENT entity name, then stop_all immediately -
      // no sleep, well inside the ~60-tick/~1s window.
      await setCompanionItems(rcon, ID, "wooden-chest", 1);
      have = await invCount(rcon, ID, "wooden-chest");
      check("7.1 setup: companion holds exactly 1 wooden-chest", have === 1, `have=${have}`);
      if (have !== 1) return;

      const start = await callTool(mcp.client, "building_place_start", { companionId: ID, entityName: "wooden-chest", x: pointB.x, y: pointB.y, direction: 0 });
      console.log("building_place_start(wooden-chest @ B) ->", JSON.stringify(start));
      check("7.1: queue accepted", start?.started === true, JSON.stringify(start));
      if (start?.started !== true) return;

      const stopAll = await callTool(mcp.client, "companion_stop_all", { companionId: ID });
      console.log("companion_stop_all(30) ->", JSON.stringify(stopAll));
      check("7.2: stop_all reports the build queue as stopped", asArray<string>(stopAll?.stopped).includes("build"), JSON.stringify(stopAll));

      const status = await pollBuildStatus(mcp, ID);
      console.log("building_place_status(after stop_all) ->", JSON.stringify(status));
      check("7.3 DECISIVE: reason === 'stopped'", status?.reason === "stopped", JSON.stringify(status));
      check("7.4 DECISIVE: entity === 'wooden-chest' (THIS run's entity, not the seeded stone-furnace leaking through)", status?.entity === "wooden-chest", JSON.stringify(status));
      check("7.5 DECISIVE: placed === false", status?.placed === false, JSON.stringify(status));

      const afterChestInv = await invCount(rcon, ID, "wooden-chest");
      check("7.6 DECISIVE: the wooden-chest item was never consumed (still held)", afterChestInv === 1, `have=${afterChestInv}`);
      const atB = await countNear(rcon, "wooden-chest", pointB, 0.6);
      check("7.7 DECISIVE: nothing exists at point B (the stopped build never created anything)", atB === 0, `count=${atB}`);
    });
  } finally {
    console.log("\n--- Teardown ---");
    try {
      let destroyed = 0;
      for (const p of placed) {
        destroyed += await destroyNear(rcon, p.name, p, 1);
      }
      console.log(`Teardown: destroyed ${destroyed} entities (of ${placed.length} tracked placements)`);

      for (const id of [ID, BYSTANDER]) {
        const pos = await companionPos(rcon, id).catch(() => null);
        await callTool(mcp.client, "companion_disappear", { companionId: id }).catch(() => {});
        // disappear spills the companion's inventory with enable_looted, so clean up after it.
        if (pos) console.log(`Teardown: swept ${await sweepGround(rcon, pos, 15)} spilled items near companion ${id}`);
      }

      const remaining = await lua(rcon, `
        local n = 0
        for _, p in ipairs({${placed.map((p) => `{name = "${p.name}", x = ${p.x}, y = ${p.y}}`).join(", ")}}) do
          n = n + #game.surfaces[1].find_entities_filtered{name = p.name, position = {x = p.x, y = p.y}, radius = 1}
        end
        rcon.print(helpers.table_to_json({remaining = n}))
      `).catch(() => ({ remaining: -1 }));
      check("teardown: no tracked arena entity left standing in the world", remaining.remaining === 0, `remaining=${remaining.remaining}`);
    } catch (e) {
      console.error("teardown error:", e);
    }
    await mcp.close();
    await rcon.close();
  }

  process.exit(summary());
}

main().catch((e) => {
  console.error("\nFATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
