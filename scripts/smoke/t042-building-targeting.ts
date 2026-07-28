// Live smoke test for the T-005 / T-039 / T-040 / T-041 building-command batch (mod 0.19.0):
// factorio-mod/commands/init.lua M.resolve_target, commands/building.lua's six rewritten
// commands, queues.lua tick_build_queues / get_build_status, and src/mcp/tools.ts's matching
// param additions.
//
// WHY THIS EXISTS. Four independent bugs shared one root cause: every coordinate-addressed
// building command searched a radius around the point and acted on find_entities_filtered's
// es[1] (engine chunk order, not distance order) instead of the entity nearest the point.
//   - T-005: building_fuel/fill/empty could hit the WRONG entity of two candidates in radius,
//     and building_empty's old radius-5 no-type-filter scan could drain a CHARACTER's own
//     inventory (chest == character_main == 1 in defines.inventory), including the player's.
//   - T-039: building_rotate reported {rotated: t.name, direction: <requested>} whether or not
//     the entity actually turned, and an out-of-range direction index silently became north
//     because u.dir_map[7] is nil.
//   - T-040: building_empty({count:45}) on a container holding >45 items raised "count must be
//     positive" AFTER moving items, because {chest, furnace_result, assembling_machine_output}
//     is literally {1, 3, 3} - the inner loop revisited index 3 with av>0 once satisfied.
//   - T-041: create_entity's real (possibly snapped) position was never returned, so a caller
//     had nothing but its own requested coordinates to hand to building_remove - and an
//     even-tile-extent entity requested at a .5 coordinate snaps to an integer, stranding it.
//
// Contract under test (frozen spec, see the T-005/039/040/041 batch): M.resolve_target picks
// the NEAREST survivor to the requested point (not es[1]), checks reach against the RESOLVED
// entity's position (not the requested point), and every success payload gains `entity` +
// `position` naming what was actually hit. Rotate validates the direction index and reads the
// direction back off the entity rather than echoing the request. Empty de-duplicates the
// inventory index list and reports the real tally even on a mid-transfer error. Place reports
// where the entity actually landed, and remove's search radius grows to 2 so it can still find
// an entity snapped away from the coordinates it was placed at.
//
// Sections (companion 42, bystander companion 43):
//   1. fuel   - two burners 2.5 tiles apart, addressed individually, verified via side-channel
//               fuel-inventory reads (not the command's own reply).
//   2. fill   - two chests, same idea.
//   3. empty  - two chests, same idea.
//   4. reach  - a point within reach 10 whose NEAREST matching entity is beyond reach 10:
//               proves the refusal checks the resolved entity, not the requested point.
//   5. loot   - a bystander companion's own inventory sits within building_empty's search
//               radius; asserts it is NOT drained (the T-005 looting hole).
//   6. rotate - a boiler actually turns, read back independently over the side channel.
//   7. rotate - a non-rotatable entity (stone-furnace) refuses instead of no-op-succeeding.
//   8. rotate - an out-of-range direction index (7) refuses instead of silently becoming north.
//   9. empty  - T-040's confirmed trigger: a furnace holding ~100 iron-plate, negative
//               coordinates, count=45 - asserts a clean 45-item extraction with no error.
//  10. empty  - count=0 refuses cleanly and moves nothing.
//  11. place/remove - an even-footprint entity (boiler) requested at a .5 coordinate reports
//               its real snapped position, and building_remove at the ORIGINAL requested
//               coordinates still finds and removes it (T-041).
//  12. fill    - count=0 refuses cleanly ("count must be positive") and moves nothing - the
//               identical zero-count trap T-040 fixed in `empty` (0 is truthy in Lua), found
//               in `fill` during code review of the T-040 fix and fixed the same way.
//
// STALE MOD CODE: this suite refuses to score against pre-0.19.0 code (see the freshness
// banner). Prefer running it through the disposable headless server, which reloads by
// construction:
//   bun run scripts/smoke/test-server.ts t042
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t042-building-targeting.ts
import { connectMCP, connectRCON, callTool, check, summary, silent } from "./lib";

const ID = 42;
const BYSTANDER = 43;
const POS_EPS = 0.05;

type RCON = { send: (cmd: string) => Promise<string> };
type Pos = { x: number; y: number };

const dist = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y);

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
 *  above). Two live companions means this must be scoped per-id, unlike a single-companion
 *  suite that can just grab "the one character with no player". */
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

/** Sanctioned in harnesses only: companions may only TAKE from a source in gameplay code, but
 *  arena setup is allowed to conjure items directly (see T-019/T-037 precedent). */
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

/** Creates an arena entity via the player's force (matches c.entity.force in building.lua's
 *  filters). Returns the ENGINE's actual (possibly snapped) position, not the request. */
async function createEntity(rcon: RCON, name: string, pos: Pos, direction?: number): Promise<{ created: boolean; x: number; y: number; unit_number?: number; direction?: number }> {
  const dirClause = direction !== undefined ? `, direction = ${direction}` : "";
  return lua(rcon, `
    local e = game.players[1].surface.create_entity{name = "${name}", position = {x=${pos.x}, y=${pos.y}}, force = game.players[1].force${dirClause}}
    if not e or not e.valid then rcon.print(helpers.table_to_json({created = false})) return end
    rcon.print(helpers.table_to_json({created = true, x = e.position.x, y = e.position.y, unit_number = e.unit_number, direction = e.direction}))
  `);
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

async function fuelInvCount(rcon: RCON, name: string, pos: Pos, item: string): Promise<number> {
  const r = await lua(rcon, `
    local es = game.surfaces[1].find_entities_filtered{name = "${name}", position = {x=${pos.x}, y=${pos.y}}, radius = 0.6}
    if #es == 0 then rcon.print(helpers.table_to_json({found = false})) return end
    local fi = es[1].get_fuel_inventory()
    rcon.print(helpers.table_to_json({found = true, count = fi and fi.get_item_count("${item}") or 0}))
  `);
  if (!r.found) throw new Error(`${name} not found near ${JSON.stringify(pos)}`);
  return r.count;
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

async function furnaceResultCount(rcon: RCON, pos: Pos, item: string): Promise<number> {
  const r = await lua(rcon, `
    local es = game.surfaces[1].find_entities_filtered{type = "furnace", position = {x=${pos.x}, y=${pos.y}}, radius = 0.6}
    if #es == 0 then rcon.print(helpers.table_to_json({found = false})) return end
    rcon.print(helpers.table_to_json({found = true, count = es[1].get_inventory(defines.inventory.furnace_result).get_item_count("${item}")}))
  `);
  if (!r.found) throw new Error(`furnace not found near ${JSON.stringify(pos)}`);
  return r.count;
}

async function insertIntoFurnaceResult(rcon: RCON, pos: Pos, item: string, count: number): Promise<number> {
  const r = await lua(rcon, `
    local es = game.surfaces[1].find_entities_filtered{type = "furnace", position = {x=${pos.x}, y=${pos.y}}, radius = 0.6}
    if #es == 0 then rcon.print(helpers.table_to_json({found = false})) return end
    rcon.print(helpers.table_to_json({found = true, inserted = es[1].get_inventory(defines.inventory.furnace_result).insert{name = "${item}", count = ${count}}}))
  `);
  if (!r.found) throw new Error(`furnace not found near ${JSON.stringify(pos)}`);
  return r.inserted;
}

/** A spot with no non-resource/tree entity within `radius` - so a two-entity arena's own
 *  radius-3 search can't accidentally pick up something pre-existing in the world. */
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

async function section(label: string, banner: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  await body();
}

async function main(): Promise<void> {
  const mcp = await connectMCP();
  const rcon = await connectRCON();
  const placed: { name: string; x: number; y: number }[] = [];

  try {
    console.log("=== Setup: spawn companions 42 (primary) and 43 (bystander) ===");
    await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
    await callTool(mcp.client, "companion_disappear", { companionId: BYSTANDER }).catch(() => {});
    const spawn1 = await callTool(mcp.client, "companion_spawn", { companionId: ID });
    const spawn2 = await callTool(mcp.client, "companion_spawn", { companionId: BYSTANDER });
    console.log("companion_spawn(42) ->", JSON.stringify(spawn1));
    console.log("companion_spawn(43) ->", JSON.stringify(spawn2));
    check("setup: companion 42 spawned (not a stale 'exists')", spawn1?.spawned === true, JSON.stringify(spawn1));
    check("setup: companion 43 spawned (not a stale 'exists')", spawn2?.spawned === true, JSON.stringify(spawn2));
    if (spawn1?.spawned !== true || spawn2?.spawned !== true) throw new Error("cannot proceed without two fresh companions");

    // ---- Freshness banner: an out-of-range direction index must REFUSE, not silently
    // rotate to north (pre-0.19.0 u.dir_map[7] is nil -> defines.direction.north, and the
    // old success shape is {rotated: <entity name>, direction: <echoed request>}). ----
    const bannerPos = await companionPos(rcon, ID);
    const bannerEnt = await createEntity(rcon, "boiler", { x: bannerPos.x + 3, y: bannerPos.y });
    if (bannerEnt.created) placed.push({ name: "boiler", x: bannerEnt.x, y: bannerEnt.y });
    const bannerRotate = bannerEnt.created
      ? await callTool(mcp.client, "building_rotate", { companionId: ID, x: bannerEnt.x, y: bannerEnt.y, direction: 7 })
      : { error: "banner boiler failed to place" };
    console.log("Banner: building_rotate(dir=7) ->", JSON.stringify(bannerRotate));
    const fresh = bannerRotate?.error === "Invalid direction";
    check(
      "banner: running mod code rejects an out-of-range direction (0.19.0+)",
      fresh,
      fresh ? "rejected as expected" : `${JSON.stringify(bannerRotate)} - pre-0.19.0 would silently rotate to north and report {rotated:<name>}`
    );
    if (!fresh) {
      throw new Error(
        "STALE MOD CODE: building_rotate accepted direction=7 instead of refusing it, so the running game predates 0.19.0. " +
        "Re-host the save, or run this through the disposable server: bun run scripts/smoke/test-server.ts t042"
      );
    }
    // defines.direction values, fetched rather than assumed (Factorio 2.0's 16-way enum
    // does NOT number cardinals 0/1/2/3 - u.dir_map maps 0..3 -> the four cardinal raw values).
    const dirs = await lua(rcon, `rcon.print(helpers.table_to_json({north=defines.direction.north, east=defines.direction.east, south=defines.direction.south, west=defines.direction.west}))`);
    console.log("defines.direction ->", JSON.stringify(dirs));

    // Base anchor: a point with nothing but resources/trees within 20 tiles, so sub-arenas
    // placed at generous offsets from it don't collide with pre-existing world content.
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

    // Give companion 42 everything the whole suite needs up front (harness-sanctioned).
    await giveCompanionItems(rcon, ID, "coal", 40);
    await giveCompanionItems(rcon, ID, "iron-plate", 60);
    await giveCompanionItems(rcon, ID, "boiler", 1);

    // ================================================================================
    await section("1", "T-005 fuel: two burners 2.5 tiles apart, addressed individually", async () => {
      const arena = { x: base.x, y: base.y };
      await teleportCompanion(rcon, ID, arena.x - 3, arena.y);

      const furnace = await createEntity(rcon, "stone-furnace", arena);
      const drill = await createEntity(rcon, "burner-mining-drill", { x: arena.x + 2.5, y: arena.y });
      if (furnace.created) placed.push({ name: "stone-furnace", x: furnace.x, y: furnace.y });
      if (drill.created) placed.push({ name: "burner-mining-drill", x: drill.x, y: drill.y });
      check("1 setup: furnace and drill both placed without colliding", furnace.created && drill.created, `furnace=${JSON.stringify(furnace)} drill=${JSON.stringify(drill)}`);
      if (!furnace.created || !drill.created) return;
      check("1 setup: the two burners are within fuel's search radius (3) of each other", dist(furnace, drill) < 3, `dist=${dist(furnace, drill)}`);

      const fuelFurnace = await callTool(mcp.client, "building_fuel", { companionId: ID, fuelName: "coal", count: 5, x: furnace.x, y: furnace.y });
      console.log("building_fuel(furnace) ->", JSON.stringify(fuelFurnace));
      check("1.1: fuel call targeting the furnace succeeds", fuelFurnace?.inserted === 5, JSON.stringify(fuelFurnace));
      check("1.2: reply names the resolved entity (furnace, not the drill)", fuelFurnace?.entity === "stone-furnace", JSON.stringify(fuelFurnace));
      check("1.3: reply's position matches the furnace, not the drill", fuelFurnace?.position && dist(fuelFurnace.position, furnace) < POS_EPS, JSON.stringify(fuelFurnace?.position));

      const furnaceFuel = await fuelInvCount(rcon, "stone-furnace", furnace, "coal");
      const drillFuelAfterFirst = await fuelInvCount(rcon, "burner-mining-drill", drill, "coal");
      check("1.4 DECISIVE: coal landed in the FURNACE's fuel inventory", furnaceFuel === 5, `furnace coal=${furnaceFuel}`);
      check("1.5 DECISIVE: the drill got NONE of it", drillFuelAfterFirst === 0, `drill coal=${drillFuelAfterFirst}`);

      const fuelDrill = await callTool(mcp.client, "building_fuel", { companionId: ID, fuelName: "coal", count: 5, x: drill.x, y: drill.y });
      console.log("building_fuel(drill) ->", JSON.stringify(fuelDrill));
      check("1.6: fuel call targeting the drill succeeds", fuelDrill?.inserted === 5, JSON.stringify(fuelDrill));
      check("1.7: reply names the resolved entity (drill, not the furnace)", fuelDrill?.entity === "burner-mining-drill", JSON.stringify(fuelDrill));

      const drillFuel = await fuelInvCount(rcon, "burner-mining-drill", drill, "coal");
      const furnaceFuelAfterSecond = await fuelInvCount(rcon, "stone-furnace", furnace, "coal");
      check("1.8 DECISIVE: coal landed in the DRILL's fuel inventory", drillFuel === 5, `drill coal=${drillFuel}`);
      check("1.9 DECISIVE: the furnace's fuel is unchanged by the second call", furnaceFuelAfterSecond === 5, `furnace coal=${furnaceFuelAfterSecond}`);
    });

    // ================================================================================
    await section("2", "T-005 fill: two chests 2.5 tiles apart, addressed individually", async () => {
      const arena = { x: base.x + 30, y: base.y };
      await teleportCompanion(rcon, ID, arena.x - 3, arena.y);

      const chestA = await createEntity(rcon, "wooden-chest", arena);
      const chestB = await createEntity(rcon, "iron-chest", { x: arena.x + 2.5, y: arena.y });
      if (chestA.created) placed.push({ name: "wooden-chest", x: chestA.x, y: chestA.y });
      if (chestB.created) placed.push({ name: "iron-chest", x: chestB.x, y: chestB.y });
      check("2 setup: both chests placed", chestA.created && chestB.created, `A=${JSON.stringify(chestA)} B=${JSON.stringify(chestB)}`);
      if (!chestA.created || !chestB.created) return;

      const fillA = await callTool(mcp.client, "building_fill", { companionId: ID, itemName: "iron-plate", count: 10, x: chestA.x, y: chestA.y });
      console.log("building_fill(chestA) ->", JSON.stringify(fillA));
      check("2.1: fill call targeting chest A succeeds", fillA?.inserted === 10, JSON.stringify(fillA));
      check("2.2: reply names the resolved entity (wooden-chest)", fillA?.entity === "wooden-chest", JSON.stringify(fillA));
      check("2.3: reply's position matches chest A", fillA?.position && dist(fillA.position, chestA) < POS_EPS, JSON.stringify(fillA?.position));

      const aIron = await chestInvCount(rcon, "wooden-chest", chestA, "iron-plate");
      const bIronAfterFirst = await chestInvCount(rcon, "iron-chest", chestB, "iron-plate");
      check("2.4 DECISIVE: iron-plate landed in chest A", aIron === 10, `chestA=${aIron}`);
      check("2.5 DECISIVE: chest B got none of it", bIronAfterFirst === 0, `chestB=${bIronAfterFirst}`);

      const fillB = await callTool(mcp.client, "building_fill", { companionId: ID, itemName: "iron-plate", count: 10, x: chestB.x, y: chestB.y });
      console.log("building_fill(chestB) ->", JSON.stringify(fillB));
      check("2.6: fill call targeting chest B succeeds", fillB?.inserted === 10, JSON.stringify(fillB));
      check("2.7: reply names the resolved entity (iron-chest)", fillB?.entity === "iron-chest", JSON.stringify(fillB));

      const bIron = await chestInvCount(rcon, "iron-chest", chestB, "iron-plate");
      const aIronAfterSecond = await chestInvCount(rcon, "wooden-chest", chestA, "iron-plate");
      check("2.8 DECISIVE: iron-plate landed in chest B", bIron === 10, `chestB=${bIron}`);
      check("2.9 DECISIVE: chest A is unchanged by the second call", aIronAfterSecond === 10, `chestA=${aIronAfterSecond}`);
    });

    // ================================================================================
    await section("3", "T-005 empty: two chests 2.5 tiles apart, addressed individually", async () => {
      const arena = { x: base.x + 60, y: base.y };
      await teleportCompanion(rcon, ID, arena.x - 3, arena.y);

      const chestA = await createEntity(rcon, "steel-chest", arena);
      const chestB = await createEntity(rcon, "wooden-chest", { x: arena.x + 2.5, y: arena.y });
      if (chestA.created) placed.push({ name: "steel-chest", x: chestA.x, y: chestA.y });
      if (chestB.created) placed.push({ name: "wooden-chest", x: chestB.x, y: chestB.y });
      check("3 setup: both chests placed", chestA.created && chestB.created, `A=${JSON.stringify(chestA)} B=${JSON.stringify(chestB)}`);
      if (!chestA.created || !chestB.created) return;

      await lua(rcon, `
        local es = game.surfaces[1].find_entities_filtered{name = "steel-chest", position = {x=${chestA.x}, y=${chestA.y}}, radius = 0.6}
        es[1].get_inventory(defines.inventory.chest).insert{name = "copper-plate", count = 20}
        rcon.print(helpers.table_to_json({ok = true}))
      `);
      await lua(rcon, `
        local es = game.surfaces[1].find_entities_filtered{name = "wooden-chest", position = {x=${chestB.x}, y=${chestB.y}}, radius = 0.6}
        es[1].get_inventory(defines.inventory.chest).insert{name = "copper-plate", count = 20}
        rcon.print(helpers.table_to_json({ok = true}))
      `);
      const beforeInv = await invCount(rcon, ID, "copper-plate");

      const emptyA = await callTool(mcp.client, "building_empty", { companionId: ID, itemName: "copper-plate", count: 8, x: chestA.x, y: chestA.y });
      console.log("building_empty(chestA) ->", JSON.stringify(emptyA));
      check("3.1: empty call targeting chest A succeeds", emptyA?.extracted === 8, JSON.stringify(emptyA));
      check("3.2: reply names the resolved entity (steel-chest)", emptyA?.entity === "steel-chest", JSON.stringify(emptyA));
      check("3.3: reply's position matches chest A", emptyA?.position && dist(emptyA.position, chestA) < POS_EPS, JSON.stringify(emptyA?.position));

      const aCopper = await chestInvCount(rcon, "steel-chest", chestA, "copper-plate");
      const bCopperAfterFirst = await chestInvCount(rcon, "wooden-chest", chestB, "copper-plate");
      check("3.4 DECISIVE: chest A lost exactly 8 (20 -> 12)", aCopper === 12, `chestA=${aCopper}`);
      check("3.5 DECISIVE: chest B is untouched", bCopperAfterFirst === 20, `chestB=${bCopperAfterFirst}`);
      check("3.6 DECISIVE: the companion's inventory actually gained 8", (await invCount(rcon, ID, "copper-plate")) - beforeInv === 8, `delta=${(await invCount(rcon, ID, "copper-plate")) - beforeInv}`);
    });

    // ================================================================================
    await section("4", "T-005 reach: refuse when the RESOLVED entity is beyond reach, even though the requested point is not", async () => {
      const arena = { x: base.x + 90, y: base.y };
      await teleportCompanion(rcon, ID, arena.x, arena.y);
      const companion = await companionPos(rcon, ID);

      // pos is 9 tiles from the companion (within reach 10); the furnace resolves within
      // fuel's search radius (3) of pos, but sits >10 tiles from the companion itself.
      const pos = { x: companion.x + 9, y: companion.y };
      const furnace = await createEntity(rcon, "stone-furnace", { x: pos.x + 2.5, y: pos.y });
      if (furnace.created) placed.push({ name: "stone-furnace", x: furnace.x, y: furnace.y });
      const dCompanionFurnace = furnace.created ? dist(companion, furnace) : -1;
      const dCompanionPos = dist(companion, pos);
      const dPosFurnace = furnace.created ? dist(pos, furnace) : -1;
      check(
        "4 setup: geometry - pos in reach, furnace resolves near pos, furnace itself beyond reach",
        furnace.created && dCompanionPos < 10 && dPosFurnace < 3 && dCompanionFurnace > 10,
        `companion-pos=${dCompanionPos.toFixed(2)} pos-furnace=${dPosFurnace.toFixed(2)} companion-furnace=${dCompanionFurnace.toFixed(2)}`
      );
      if (!(furnace.created && dCompanionPos < 10 && dPosFurnace < 3 && dCompanionFurnace > 10)) return;

      const refused = await callTool(mcp.client, "building_fuel", { companionId: ID, fuelName: "coal", count: 1, x: pos.x, y: pos.y });
      console.log("building_fuel(pos in reach, entity beyond reach) ->", JSON.stringify(refused));
      check("4.1: refused with the structured 'Too far' error", refused?.error === "Too far", JSON.stringify(refused));
      check("4.2: refusal target is present (for the caller to walk to and retry)", !!refused?.target, JSON.stringify(refused?.target));

      const noFuelYet = await fuelInvCount(rcon, "stone-furnace", furnace, "coal");
      check("4.3 DECISIVE: nothing was inserted despite pos itself being in reach", noFuelYet === 0, `furnace coal=${noFuelYet}`);

      // Positive control: move the companion close enough that the RESOLVED entity (not just
      // pos) is in reach, and the identical call now succeeds - proving 4.1 wasn't a refusal
      // that fires unconditionally regardless of geometry.
      await teleportCompanion(rcon, ID, furnace.x - 2, furnace.y);
      const accepted = await callTool(mcp.client, "building_fuel", { companionId: ID, fuelName: "coal", count: 1, x: pos.x, y: pos.y });
      console.log("building_fuel(furnace now in reach) ->", JSON.stringify(accepted));
      check("4.4 positive control: same call succeeds once the resolved entity is in reach", accepted?.inserted === 1, JSON.stringify(accepted));
    });

    // ================================================================================
    await section("5", "T-005 looting hole: building_empty must not drain a character's own inventory", async () => {
      const arena = { x: base.x + 120, y: base.y };
      await teleportCompanion(rcon, ID, arena.x, arena.y);
      await teleportCompanion(rcon, BYSTANDER, arena.x + 1.5, arena.y);
      await giveCompanionItems(rcon, BYSTANDER, "iron-plate", 15);
      const bystanderBefore = await invCount(rcon, BYSTANDER, "iron-plate");
      check("5 setup: bystander companion holds 15 iron-plate within empty's search radius (3)", bystanderBefore === 15, `bystander iron=${bystanderBefore}`);

      const bystanderPos = await companionPos(rcon, BYSTANDER);
      const result = await callTool(mcp.client, "building_empty", { companionId: ID, itemName: "iron-plate", count: 10, x: bystanderPos.x, y: bystanderPos.y });
      console.log("building_empty(targeting a character) ->", JSON.stringify(result));
      check("5.1: refuses rather than extracting from a character (allow_characters defaults false)", result?.error !== undefined && result?.extracted === undefined, JSON.stringify(result));

      const bystanderAfter = await invCount(rcon, BYSTANDER, "iron-plate");
      check("5.2 DECISIVE: bystander's inventory is untouched", bystanderAfter === 15, `bystander iron before=${bystanderBefore} after=${bystanderAfter}`);
    });

    // ================================================================================
    await section("6", "T-039 rotate: a boiler actually turns, confirmed independently over the side channel", async () => {
      const arena = { x: base.x + 150, y: base.y };
      await teleportCompanion(rcon, ID, arena.x, arena.y);

      const boiler = await createEntity(rcon, "boiler", arena, dirs.north);
      if (boiler.created) placed.push({ name: "boiler", x: boiler.x, y: boiler.y });
      check("6 setup: boiler placed facing north", boiler.created && boiler.direction === dirs.north, JSON.stringify(boiler));
      if (!boiler.created) return;

      const rotate = await callTool(mcp.client, "building_rotate", { companionId: ID, x: boiler.x, y: boiler.y, direction: 1 });
      console.log("building_rotate(east) ->", JSON.stringify(rotate));
      check("6.1: rotated === true", rotate?.rotated === true, JSON.stringify(rotate));
      check("6.2: reply names the resolved entity", rotate?.entity === "boiler", JSON.stringify(rotate));
      check("6.3: reply echoes the requested direction_index", rotate?.direction_index === 1, JSON.stringify(rotate));
      check("6.4: reply's `direction` is the raw defines value (east), not the echoed index", rotate?.direction === dirs.east, `reply direction=${rotate?.direction} expected=${dirs.east}`);

      const truth = await lua(rcon, `
        local es = game.surfaces[1].find_entities_filtered{name = "boiler", position = {x=${boiler.x}, y=${boiler.y}}, radius = 0.6}
        if #es == 0 then rcon.print(helpers.table_to_json({found = false})) return end
        rcon.print(helpers.table_to_json({found = true, direction = es[1].direction}))
      `);
      check("6.5 DECISIVE: the entity's real direction (read back independently) equals east", truth.found && truth.direction === dirs.east, JSON.stringify(truth));
    });

    // ================================================================================
    // T-039 follow-up: e.rotatable was probed true for EVERY entity (chests, poles, labs
    // included) and filtered nothing, so it's gone from resolve_target's predicate; the real
    // gate is the supports_direction check further down the handler. This section proves the
    // three distinct refusals (unrotatable entity, no-op assign, nothing found) are each pinned
    // to their own exact error string rather than accepted by a generic "reply has an error".
    await section("7", "T-039 rotate: three distinct refusals, each pinned to its exact error string, plus a positive control", async () => {
      const arena = { x: base.x + 150, y: base.y + 10 };
      await teleportCompanion(rcon, ID, arena.x, arena.y);

      // 7a - genuinely unrotatable entity (supports_direction === false).
      const chest = await createEntity(rcon, "wooden-chest", arena);
      if (chest.created) placed.push({ name: "wooden-chest", x: chest.x, y: chest.y });
      check("7a setup: wooden-chest placed", chest.created, JSON.stringify(chest));
      if (!chest.created) return;

      const chestSupportsDirection = await lua(rcon, `rcon.print(helpers.table_to_json({supports = prototypes.entity["wooden-chest"].supports_direction}))`);
      check("7a setup: wooden-chest's own prototype confirms supports_direction === false (not assumed)", chestSupportsDirection.supports === false, JSON.stringify(chestSupportsDirection));

      const rotateChest = await callTool(mcp.client, "building_rotate", { companionId: ID, x: chest.x, y: chest.y, direction: 1 });
      console.log("building_rotate(wooden-chest) ->", JSON.stringify(rotateChest));
      check("7a.1: exact error 'Entity does not support direction'", rotateChest?.error === "Entity does not support direction", JSON.stringify(rotateChest));
      check("7a.2: reply names the entity", rotateChest?.entity === "wooden-chest", JSON.stringify(rotateChest));
      check("7a.3: no `rotated` field on a refusal", rotateChest?.rotated === undefined, JSON.stringify(rotateChest));
      // With entityName omitted there's no name filter at radius 1, so `position` is what proves
      // WHICH nearby entity resolve_target actually picked - not just that something refused.
      check("7a.4: reply carries `position` matching the resolved chest", rotateChest?.position && dist(rotateChest.position, chest) < POS_EPS, JSON.stringify(rotateChest?.position));

      const chestTruth = await lua(rcon, `
        local es = game.surfaces[1].find_entities_filtered{name = "wooden-chest", position = {x=${chest.x}, y=${chest.y}}, radius = 0.6}
        rcon.print(helpers.table_to_json({direction = es[1] and es[1].direction}))
      `);
      check("7a.5 DECISIVE: the chest's real direction is unchanged (still 0)", chestTruth.direction === 0, JSON.stringify(chestTruth));

      // 7b - supports_direction is true, but the assign is a no-op (this is what the old
      // section actually exercised, under a misleading "not rotatable" label). This reaches
      // the assign -> read-back -> compare path, NOT the supports_direction guard above.
      const furnace = await createEntity(rcon, "stone-furnace", { x: arena.x + 3, y: arena.y });
      if (furnace.created) placed.push({ name: "stone-furnace", x: furnace.x, y: furnace.y });
      check("7b setup: stone-furnace placed", furnace.created, JSON.stringify(furnace));
      if (!furnace.created) return;

      const rotateFurnace = await callTool(mcp.client, "building_rotate", { companionId: ID, x: furnace.x, y: furnace.y, direction: 1 });
      console.log("building_rotate(stone-furnace) ->", JSON.stringify(rotateFurnace));
      check("7b.1: exact error 'Rotate had no effect'", rotateFurnace?.error === "Rotate had no effect", JSON.stringify(rotateFurnace));
      check("7b.2: reply carries `direction` (read-back) and `requested`, and they DIFFER", typeof rotateFurnace?.direction === "number" && typeof rotateFurnace?.requested === "number" && rotateFurnace.direction !== rotateFurnace.requested, JSON.stringify(rotateFurnace));

      const furnaceTruth = await lua(rcon, `
        local es = game.surfaces[1].find_entities_filtered{name = "stone-furnace", position = {x=${furnace.x}, y=${furnace.y}}, radius = 0.6}
        rcon.print(helpers.table_to_json({direction = es[1] and es[1].direction}))
      `);
      check("7b.3 DECISIVE: the furnace's real direction is unchanged (matches the reply's read-back)", furnaceTruth.direction === rotateFurnace?.direction, JSON.stringify(furnaceTruth));

      // 7c - nothing at the coordinates at all. Offset well clear of the chest/furnace just
      // placed; verify empty first so this can't accidentally resolve one of them.
      const emptySpot = { x: arena.x - 6, y: arena.y - 6 };
      const emptyCheck = await lua(rcon, `rcon.print(helpers.table_to_json({n = #game.surfaces[1].find_entities_filtered{position = {x=${emptySpot.x}, y=${emptySpot.y}}, radius = 1}}))`);
      check("7c setup: nothing within radius 1 of the empty spot", emptyCheck.n === 0, JSON.stringify(emptyCheck));

      const rotateEmpty = await callTool(mcp.client, "building_rotate", { companionId: ID, x: emptySpot.x, y: emptySpot.y, direction: 1 });
      console.log("building_rotate(empty spot) ->", JSON.stringify(rotateEmpty));
      check("7c.1: exact error 'No entity found' - proves 7a's refusal is specific, not a generic failure", rotateEmpty?.error === "No entity found", JSON.stringify(rotateEmpty));

      // 7d - positive control: without this, 7a-7c could all pass on a command that refuses
      // everything.
      const inserter = await createEntity(rcon, "inserter", { x: arena.x - 3, y: arena.y }, dirs.north);
      if (inserter.created) placed.push({ name: "inserter", x: inserter.x, y: inserter.y });
      check("7d setup: inserter placed facing north", inserter.created && inserter.direction === dirs.north, JSON.stringify(inserter));
      if (!inserter.created) return;

      const rotateInserter = await callTool(mcp.client, "building_rotate", { companionId: ID, x: inserter.x, y: inserter.y, direction: 1 });
      console.log("building_rotate(inserter) ->", JSON.stringify(rotateInserter));
      check("7d.1: rotated === true", rotateInserter?.rotated === true, JSON.stringify(rotateInserter));
      check("7d.2: reply's `direction` equals the live-fetched east", rotateInserter?.direction === dirs.east, `reply direction=${rotateInserter?.direction} expected=${dirs.east}`);

      const inserterTruth = await lua(rcon, `
        local es = game.surfaces[1].find_entities_filtered{name = "inserter", position = {x=${inserter.x}, y=${inserter.y}}, radius = 0.6}
        rcon.print(helpers.table_to_json({direction = es[1] and es[1].direction}))
      `);
      check("7d.3 DECISIVE: the inserter's real direction (read back independently) equals east", inserterTruth.direction === dirs.east, JSON.stringify(inserterTruth));
    });

    // ================================================================================
    await section("8", "T-039 rotate: an out-of-range direction index refuses instead of silently becoming north", async () => {
      const arena = { x: base.x + 150, y: base.y + 20 };
      await teleportCompanion(rcon, ID, arena.x, arena.y);

      const boiler = await createEntity(rcon, "boiler", arena, dirs.east);
      if (boiler.created) placed.push({ name: "boiler", x: boiler.x, y: boiler.y });
      check("8 setup: boiler placed facing east (not north - so a silent fallback to north is detectable)", boiler.created && boiler.direction === dirs.east, JSON.stringify(boiler));
      if (!boiler.created) return;

      const rotate = await callTool(mcp.client, "building_rotate", { companionId: ID, x: boiler.x, y: boiler.y, direction: 7 });
      console.log("building_rotate(dir=7) ->", JSON.stringify(rotate));
      check("8.1: reply is 'Invalid direction', echoing the bad index", rotate?.error === "Invalid direction" && rotate?.direction === 7, JSON.stringify(rotate));

      const truth = await lua(rcon, `
        local es = game.surfaces[1].find_entities_filtered{name = "boiler", position = {x=${boiler.x}, y=${boiler.y}}, radius = 0.6}
        rcon.print(helpers.table_to_json({direction = es[1] and es[1].direction}))
      `);
      check("8.2 DECISIVE: the entity's real direction is UNCHANGED (still east, not north)", truth.direction === dirs.east, JSON.stringify(truth));
    });

    // ================================================================================
    let t040FurnacePos: Pos | null = null;
    await section("9", "T-040 empty: negative coordinates, count=45, a furnace holding ~100 (the confirmed {1,3,3} aliasing trigger)", async () => {
      const candidates: Pos[] = [{ x: -80, y: -80 }, { x: -150, y: -80 }, { x: -80, y: -150 }, { x: -150, y: -150 }];
      const arena = await findClearSpot(rcon, candidates, 12);
      console.log("T-040 arena (negative territory) ->", JSON.stringify(arena));
      await teleportCompanion(rcon, ID, arena.x + 1, arena.y);

      const furnace = await createEntity(rcon, "stone-furnace", arena);
      if (furnace.created) placed.push({ name: "stone-furnace", x: furnace.x, y: furnace.y });
      check("9 setup: furnace placed at negative coordinates", furnace.created && furnace.x < 0 && furnace.y < 0, JSON.stringify(furnace));
      if (!furnace.created) return;
      t040FurnacePos = { x: furnace.x, y: furnace.y };

      const inserted = await insertIntoFurnaceResult(rcon, furnace, "iron-plate", 100);
      check("9 setup: 100 iron-plate inserted into the furnace's result slot", inserted === 100, `inserted=${inserted}`);
      if (inserted !== 100) return;

      const before = await invCount(rcon, ID, "iron-plate");
      const emptyRes = await callTool(mcp.client, "building_empty", { companionId: ID, itemName: "iron-plate", count: 45, x: furnace.x, y: furnace.y });
      console.log("building_empty(count=45, negative coords) ->", JSON.stringify(emptyRes));
      check("9.1: no `error` field (pre-fix this raised 'count must be positive' AFTER moving items)", emptyRes?.error === undefined, JSON.stringify(emptyRes));
      check("9.2: extracted === 45 exactly", emptyRes?.extracted === 45, JSON.stringify(emptyRes));

      const after = await invCount(rcon, ID, "iron-plate");
      check("9.3 DECISIVE: the companion's inventory really gained 45", after - before === 45, `before=${before} after=${after}`);
      const remaining = await furnaceResultCount(rcon, furnace, "iron-plate");
      check("9.4 DECISIVE: the furnace has exactly 55 left (100 - 45)", remaining === 55, `remaining=${remaining}`);
    });

    await section("10", "T-040 empty: count=0 refuses cleanly and moves nothing", async () => {
      if (!t040FurnacePos) { check("10: skipped - section 9 setup did not complete", false, "no furnace to target"); return; }
      const before = await invCount(rcon, ID, "iron-plate");
      const beforeFurnace = await furnaceResultCount(rcon, t040FurnacePos, "iron-plate");
      check("10 setup precondition: furnace genuinely HAS iron-plate (nonzero, so an empty target can't pass for the wrong reason)", beforeFurnace > 0, `furnace iron-plate=${beforeFurnace}`);

      const emptyRes = await callTool(mcp.client, "building_empty", { companionId: ID, itemName: "iron-plate", count: 0, x: t040FurnacePos.x, y: t040FurnacePos.y });
      console.log("building_empty(count=0) ->", JSON.stringify(emptyRes));
      check("10.1: clean refusal 'count must be positive'", emptyRes?.error === "count must be positive", JSON.stringify(emptyRes));

      const after = await invCount(rcon, ID, "iron-plate");
      const afterFurnace = await furnaceResultCount(rcon, t040FurnacePos, "iron-plate");
      check("10.2 DECISIVE: companion inventory unchanged", after === before, `before=${before} after=${after}`);
      check("10.3 DECISIVE: furnace contents unchanged", afterFurnace === beforeFurnace, `before=${beforeFurnace} after=${afterFurnace}`);
    });

    // ================================================================================
    await section("11", "T-041: an even-footprint entity requested at a .5 coordinate reports its REAL snapped position, and remove at the ORIGINAL requested coordinates still finds it", async () => {
      // Verified live before writing this arithmetic (see report, not hardcoded from the card):
      // prototypes.entity["boiler"].tile_width=3 (odd), tile_height=2 (even), and a north-facing
      // create_entity at (250.5, 180.5) actually landed at (250.5, 181) - x unchanged, y snapped
      // to the nearest integer. So a LEGAL request is (X.5, Y.5) for integer X, Y: x's odd extent
      // makes .5 already valid and stable; y's even extent is what the engine moves.
      // base.x/base.y themselves came from a live-found clear spot, i.e. arbitrary floats - adding
      // 0.5 to that raw float (the original bug) produces neither a legal nor a predictable
      // parity, hence the prior run's (334.4, 15.7) and its "Cannot place" refusal.
      const anchorX = Math.floor(base.x + 210);
      const anchorY = Math.floor(base.y);
      const reqX = anchorX + 0.5;
      const reqY = anchorY + 0.5;
      await teleportCompanion(rcon, ID, anchorX, anchorY);

      const beforeBoilers = await countNear(rcon, "boiler", { x: reqX, y: reqY }, 5);
      check("11 setup: no pre-existing boiler within 5 tiles of the request point", beforeBoilers === 0, `count=${beforeBoilers}`);

      const place = await callTool(mcp.client, "building_place", { companionId: ID, entityName: "boiler", x: reqX, y: reqY, direction: 0 });
      console.log(`building_place(boiler @ ${reqX},${reqY}) ->`, JSON.stringify(place));
      check("11.1: placed === true", place?.placed === true, JSON.stringify(place));
      check("11.2: reply names the entity", place?.entity === "boiler", JSON.stringify(place));
      check("11.3: reply carries a position", !!place?.position, JSON.stringify(place?.position));
      if (!place?.position) return;
      check("11.4: reported position.x EQUALS the requested x (odd extent - already legal, no snap)", Math.abs(place.position.x - reqX) < POS_EPS, `requested x=${reqX} reported x=${place.position.x}`);
      check("11.5 DECISIVE: reported position.y DIFFERS from the requested .5 y (even extent - engine snapped it, and the fix now reports where)", Math.abs(place.position.y - reqY) > POS_EPS, `requested y=${reqY} reported y=${place.position.y}`);
      placed.push({ name: "boiler", x: place.position.x, y: place.position.y });

      const remove = await callTool(mcp.client, "building_remove", { companionId: ID, entityName: "boiler", x: reqX, y: reqY });
      console.log("building_remove(at ORIGINAL requested coords) ->", JSON.stringify(remove));
      check("11.6 DECISIVE: remove at the ORIGINAL requested (unsnapped) coordinates succeeds", remove?.removed === true, JSON.stringify(remove));

      const atSnapped = await countNear(rcon, "boiler", place.position, 0.6);
      check("11.7 DECISIVE: the entity is actually gone from its real (snapped) position", atSnapped === 0, `count=${atSnapped}`);
      const stray = await countNear(rcon, "boiler", { x: reqX, y: reqY }, 5);
      check("11.8 DECISIVE: no stray boiler left within 5 tiles of the request point", stray === 0, `count=${stray}`);
    });

    // ================================================================================
    await section("12", "fill's own zero-count guard (found during code review of the T-040 fix): count=0 refuses cleanly and moves nothing", async () => {
      const arena = { x: base.x + 240, y: base.y };
      await teleportCompanion(rcon, ID, arena.x - 3, arena.y);

      const chest = await createEntity(rcon, "wooden-chest", arena);
      if (chest.created) placed.push({ name: "wooden-chest", x: chest.x, y: chest.y });
      check("12 setup: chest placed", chest.created, JSON.stringify(chest));
      if (!chest.created) return;

      await giveCompanionItems(rcon, ID, "stone", 20);
      const beforeInv = await invCount(rcon, ID, "stone");
      const beforeChest = await chestInvCount(rcon, "wooden-chest", chest, "stone");
      // The companion must genuinely HAVE the item: fill returns {error:"No <item>"} early when
      // have==0, which would make a count=0 test pass for the WRONG reason (never reaching the
      // new guard at all) and prove nothing about the fix under test.
      check("12 setup precondition: companion genuinely HAS the item (have>0)", beforeInv > 0, `companion stone=${beforeInv}`);

      const fillRes = await callTool(mcp.client, "building_fill", { companionId: ID, itemName: "stone", count: 0, x: chest.x, y: chest.y });
      console.log("building_fill(count=0) ->", JSON.stringify(fillRes));
      check("12.1: clean refusal 'count must be positive' (not a raised engine error, not 'No stone')", fillRes?.error === "count must be positive", JSON.stringify(fillRes));

      const afterInv = await invCount(rcon, ID, "stone");
      const afterChest = await chestInvCount(rcon, "wooden-chest", chest, "stone");
      check("12.2 DECISIVE: companion inventory unchanged", afterInv === beforeInv, `before=${beforeInv} after=${afterInv}`);
      check("12.3 DECISIVE: chest contents unchanged", afterChest === beforeChest, `before=${beforeChest} after=${afterChest}`);
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
        if (pos) console.log(`Teardown: swept ${await sweepGround(rcon, pos)} spilled items near companion ${id}`);
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
