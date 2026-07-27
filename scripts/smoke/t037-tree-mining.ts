// Live smoke test for T-037: "the companion can harvest wood" (factorio-mod/commands/init.lua
// u.resource_filter, resource.lua fac_resource_nearest / fac_resource_mine, queues.lua
// start_harvest, world.lua fac_world_nearest - mod 0.18.0).
//
// WHY THIS EXISTS. Small electric poles cost 1 wood each and are the only pole available until
// steel-processing, so the T-001 pole line (~16 poles) cannot be built without wood. Before
// 0.18.0 the companion could FIND a tree (world_nearest already special-cased type="tree") but
// could not mine one: both fac_resource_mine and queues.start_harvest seeded their entity pool
// with find_entities_filtered{type = "resource"}, and a tree is type = "tree". Asking for wood
// therefore returned {error = "No resource"} - a capability gap, not a bug in the queue.
//
// Contract under test:
//   - Wood is the one harvestable that cannot be selected by NAME. Trees ship dozens of
//     prototypes (tree-01 .. tree-06-brown .. dead-dry-hairy-tree), so {name = "wood"} matches
//     nothing at all. u.resource_filter maps the tokens "wood"/"tree" to {type = "tree"} and
//     everything else to {name = normalize(token)}, and is now the SINGLE place that split
//     lives - resource_nearest, world_nearest and start_harvest all route through it, so they
//     cannot drift apart the way resource.lua and world.lua already had (each carried its own
//     copy of the alias table, and only world.lua knew about trees).
//   - `amount` is a resource-only LuaEntity property; reading it off a tree RAISES. So
//     resource_nearest reports it only for entities of type "resource" and omits it for trees.
//     This is the one genuinely new failure mode the feature introduces, hence section B.
//   - Nothing in the harvest queue itself needed changing, which section D is what proves. The
//     tick loop counts a main-inventory delta every tick and advances on
//     `q.current.entity.valid` going false - and a tree is a better fit for that than ore is: a
//     tree is genuinely CONSUMED when mined (valid -> false), whereas an ore tile only
//     decrements `amount` and stays valid, which is the very thing that pinned `harvested` at 0
//     for four releases (see the mining_state notes in CLAUDE.md).
//
// STALE MOD CODE. A running game keeps executing the control-stage code it loaded at the last
// save load; game.reload_script() does NOT reload it in a hosted multiplayer game (re-confirmed
// live 2026-07-27 - both reload calls returned success and changed nothing). So this suite opens
// with a behavioural freshness banner and refuses to score against old code. The discriminator
// is the feature itself: pre-0.18.0, resource_nearest("wood") searched {name = "wood"}, which
// matches no prototype, and so replied {error: "Not found"} even standing next to a forest.
// Prefer running it through the disposable headless server, which reloads by construction:
//   bun run scripts/smoke/test-server.ts t037
//
// Sections (all against companion 57):
//   A. resource_nearest("wood") resolves to a real tree, at the entity's exact position.
//   B. `amount` is present for ore and absent for wood (the .amount raise-guard).
//   C. Constructed arena: three planted trees at ~2 / ~12 / ~30 tiles - the nearest wins, so
//      min-picking is deterministic rather than a property of whatever the map looked like.
//   D. End-to-end harvest: the companion actually gains wood, the counted `harvested` equals the
//      real inventory delta, and the queue TERMINATES with reason "target_reached".
//   E. Regressions over the shared filter path: ore mining still harvests, world_nearest's tree
//      and water branches still answer after losing their private copy of the alias table, and
//      an unknown token still reports "Not found" rather than throwing.
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t037-tree-mining.ts
import { connectMCP, connectRCON, callTool, check, summary, silent } from "./lib";

const ID = 57;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

type RCON = { send: (cmd: string) => Promise<string> };

/** silent() returns raw text; every probe here answers with one helpers.table_to_json line. */
async function lua(rcon: RCON, body: string): Promise<any> {
  const raw = await silent(rcon, body);
  const line = raw.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`no JSON in RCON reply: ${raw.slice(0, 300)}`);
  return JSON.parse(line);
}

/** storage.companions is not reachable from /silent-command, so ask the mod itself. */
async function companionPos(rcon: RCON): Promise<{ x: number; y: number }> {
  const raw = await rcon.send(`/fac_companion_position ${ID}`);
  const d = JSON.parse(raw.split("\n").find((l) => l.trim().startsWith("{"))!);
  if (!d?.position) throw new Error(`companion ${ID} has no position: ${raw}`);
  return d.position;
}

/** The companion character is the one character entity with no attached player. */
const COMPANION_LUA = `
  local tgt
  for _, e in pairs(game.surfaces[1].find_entities_filtered{type = "character"}) do
    if e.player == nil then tgt = e end
  end
`;

async function teleport(rcon: RCON, x: number, y: number): Promise<boolean> {
  const r = await lua(rcon, `
    ${COMPANION_LUA}
    if not tgt then rcon.print(helpers.table_to_json({teleported = false, error = "no companion character"})) return end
    local ok = tgt.teleport({${x}, ${y}})
    rcon.print(helpers.table_to_json({teleported = ok, pos = tgt.position}))
  `);
  return r.teleported === true;
}

/** An anchor with no natural tree within `clear` tiles, so a planted arena is unambiguous. */
async function findClearAnchor(rcon: RCON, from: { x: number; y: number }, clear: number): Promise<{ x: number; y: number }> {
  const r = await lua(rcon, `
    local s = game.surfaces[1]
    local base = {x = ${from.x}, y = ${from.y}}
    for _, r in ipairs({60, 100, 150, 220, 300, 400}) do
      for _, a in ipairs({0, 45, 90, 135, 180, 225, 270, 315}) do
        local p = {x = base.x + r * math.cos(math.rad(a)), y = base.y + r * math.sin(math.rad(a))}
        local trees = s.find_entities_filtered{position = p, radius = ${clear}, type = "tree", limit = 1}
        local water = s.find_tiles_filtered{position = p, radius = 8, name = {"water", "deepwater"}, limit = 1}
        if #trees == 0 and #water == 0 then
          rcon.print(helpers.table_to_json({found = true, x = p.x, y = p.y})) return
        end
      end
    end
    rcon.print(helpers.table_to_json({found = false}))
  `);
  if (!r.found) throw new Error("no tree-free anchor found within 400 tiles - cannot build a deterministic arena");
  return { x: r.x, y: r.y };
}

/** Plant trees at exact offsets. Teardown keys on POSITION: trees carry no useful unit_number,
 *  and an id-keyed teardown silently no-ops and leaves the arena standing in the world. */
async function plantTrees(rcon: RCON, at: { x: number; y: number }[]): Promise<{ planted: { x: number; y: number }[]; name: string }> {
  const spec = at.map((p) => `{x = ${p.x}, y = ${p.y}}`).join(", ");
  const r = await lua(rcon, `
    local s = game.surfaces[1]
    local tree_name
    for name, proto in pairs(prototypes.entity) do
      if proto.type == "tree" and proto.mineable_properties and proto.mineable_properties.minable then
        tree_name = name break
      end
    end
    if not tree_name then rcon.print(helpers.table_to_json({error = "no minable tree prototype"})) return end
    local planted = {}
    for _, p in ipairs({${spec}}) do
      local e = s.create_entity{name = tree_name, position = p, force = "neutral"}
      if e and e.valid then planted[#planted + 1] = {x = e.position.x, y = e.position.y} end
    end
    rcon.print(helpers.table_to_json({planted = planted, name = tree_name}))
  `);
  if (r.error) throw new Error(r.error);
  return { planted: Array.isArray(r.planted) ? r.planted : [], name: r.name };
}

async function destroyTrees(rcon: RCON, at: { x: number; y: number }[]): Promise<number> {
  if (at.length === 0) return 0;
  const spec = at.map((p) => `{x = ${p.x}, y = ${p.y}}`).join(", ");
  const r = await lua(rcon, `
    local s = game.surfaces[1]
    local n = 0
    for _, p in ipairs({${spec}}) do
      for _, e in pairs(s.find_entities_filtered{position = p, radius = 0.6, type = "tree"}) do
        if e.valid then e.destroy() n = n + 1 end
      end
    end
    rcon.print(helpers.table_to_json({destroyed = n}))
  `);
  return r.destroyed;
}

/** Spilled stacks split across several item-entity entities, so sum COUNTS per name. */
async function sweepGround(rcon: RCON, at: { x: number; y: number }, radius = 12): Promise<number> {
  const r = await lua(rcon, `
    local s = game.surfaces[1]
    local n = 0
    for _, e in pairs(s.find_entities_filtered{position = {x = ${at.x}, y = ${at.y}}, radius = ${radius}, name = "item-on-ground"}) do
      if e.valid then n = n + (e.stack and e.stack.valid_for_read and e.stack.count or 0) e.destroy() end
    end
    rcon.print(helpers.table_to_json({swept = n}))
  `);
  return r.swept;
}

async function invCount(rcon: RCON, item: string): Promise<number> {
  const raw = await rcon.send(`/fac_companion_inventory ${ID}`);
  const d = JSON.parse(raw.split("\n").find((l) => l.trim().startsWith("{"))!);
  const items = Array.isArray(d?.items) ? d.items : [];
  return items.find((i: any) => i.name === item)?.count ?? 0;
}

/** Poll to a terminal harvest result, so a hang fails loudly instead of scoring a stale read. */
async function awaitHarvest(rcon: RCON, timeoutMs: number): Promise<any> {
  const started = Date.now();
  let last: any = null;
  while (Date.now() - started < timeoutMs) {
    const raw = await rcon.send(`/fac_resource_mine_status ${ID}`);
    last = JSON.parse(raw.split("\n").find((l) => l.trim().startsWith("{"))!)?.status ?? null;
    if (last && last.active === false) return last;
    await sleep(500);
  }
  return { timedOut: true, last };
}

async function section(label: string, banner: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  await body();
}

async function main(): Promise<void> {
  const mcp = await connectMCP();
  const rcon = await connectRCON();
  let planted: { x: number; y: number }[] = [];
  let arena: { x: number; y: number } | null = null;

  try {
    // A stale companion makes spawn a silent no-op ({status:"exists"}) that skips spawn-time
    // work entirely, so always remove first and assert a real spawn.
    await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
    const spawn = await callTool(mcp.client, "companion_spawn", { companionId: ID });
    console.log("companion_spawn ->", JSON.stringify(spawn));
    check("setup: companion spawned (not a stale 'exists')", spawn?.spawned === true, JSON.stringify(spawn));
    if (spawn?.spawned !== true) throw new Error("cannot proceed without a fresh companion");

    // ---- Freshness banner -------------------------------------------------------------
    const banner = await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "wood" });
    console.log("Banner: resource_nearest(wood) ->", JSON.stringify(banner));
    const fresh = !!banner?.position;
    check(
      "banner: running mod code understands the 'wood' token (0.18.0+)",
      fresh,
      fresh ? `resolved ${banner.resource}` : `${JSON.stringify(banner)} - pre-0.18.0 searched {name="wood"}, which matches no prototype`
    );
    if (!fresh) {
      throw new Error(
        "STALE MOD CODE: resource_nearest(wood) found nothing, so the running game predates 0.18.0. " +
        "A hosted game only reloads control-stage Lua on save load. Re-host the save, or run this " +
        "through the disposable server: bun run scripts/smoke/test-server.ts t037"
      );
    }

    await section("A", "resource_nearest resolves wood to a real tree", async () => {
      const r = await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "wood" });
      const truth = await lua(rcon, `
        ${COMPANION_LUA}
        local best, min
        for _, e in pairs(game.surfaces[1].find_entities_filtered{position = tgt.position, radius = 200, type = "tree"}) do
          local d = math.sqrt((e.position.x - tgt.position.x)^2 + (e.position.y - tgt.position.y)^2)
          if not min or d < min then min = d best = e end
        end
        if not best then rcon.print(helpers.table_to_json({none = true})) return end
        rcon.print(helpers.table_to_json({name = best.name, x = best.position.x, y = best.position.y, d = min, type = best.type}))
      `);
      check("A1: reply names a tree prototype", truth.type === "tree" && r.resource === truth.name, `tool=${r.resource} truth=${truth.name} (type ${truth.type})`);
      check("A2: position is the independent sweep's nearest tree", Math.abs(r.position.x - truth.x) < 0.01 && Math.abs(r.position.y - truth.y) < 0.01, `tool=${JSON.stringify(r.position)} truth=(${truth.x},${truth.y})`);
      check("A3: distance is unfloored (matches the real euclidean distance)", Math.abs(r.distance - truth.d) < 0.01, `tool=${r.distance} truth=${truth.d}`);
      check("A4: 'tree' is accepted as a synonym for 'wood'", (await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "tree" }))?.resource === r.resource, "tree token should resolve identically");
    });

    await section("B", "the .amount raise-guard: present for ore, absent for wood", async () => {
      const wood = await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "wood" });
      const ore = await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "coal" });
      check("B1: wood reply omits `amount` (reading it off a tree raises)", wood.amount === undefined, `amount=${JSON.stringify(wood.amount)}`);
      check("B2: wood reply still carries resource/position/distance", !!wood.resource && !!wood.position && typeof wood.distance === "number", JSON.stringify(wood));
      check("B3: ore reply still carries `amount` (guard did not over-reach)", typeof ore.amount === "number" && ore.amount > 0, JSON.stringify(ore));
    });

    await section("C", "constructed arena: the nearest planted tree wins", async () => {
      const here = await companionPos(rcon);
      arena = await findClearAnchor(rcon, here, 45);
      console.log(`arena anchor (no natural tree within 45) -> ${JSON.stringify(arena)}`);
      check("C setup: companion teleported to the arena anchor", await teleport(rcon, arena.x, arena.y), JSON.stringify(arena));

      const want = [
        { x: arena.x + 2, y: arena.y },
        { x: arena.x + 12, y: arena.y },
        { x: arena.x, y: arena.y + 30 }
      ];
      const res = await plantTrees(rcon, want);
      planted = res.planted;
      console.log(`planted ${planted.length} x ${res.name} -> ${JSON.stringify(planted)}`);
      check("C setup: three trees planted", planted.length === 3, `planted=${planted.length}`);

      const r = await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "wood" });
      const nearest = planted.reduce((a, b) => (dist(a, arena!) <= dist(b, arena!) ? a : b));
      check("C1: reply picks the ~2-tile tree, not the 12- or 30-tile one", Math.abs(r.position.x - nearest.x) < 0.6 && Math.abs(r.position.y - nearest.y) < 0.6, `tool=${JSON.stringify(r.position)} nearest planted=${JSON.stringify(nearest)}`);
      check("C2: reported distance matches that tree", Math.abs(r.distance - dist(arena!, nearest)) < 0.6, `tool=${r.distance} expected~${dist(arena!, nearest).toFixed(2)}`);
    });

    await section("D", "end-to-end harvest: wood actually enters the inventory and the queue ends", async () => {
      const target = 3;
      const before = await invCount(rcon, "wood");
      const nearest = planted.reduce((a, b) => (dist(a, arena!) <= dist(b, arena!) ? a : b));
      // Park inside resource_reach_distance (2.7) of the tree, the same bound ore mining uses.
      check("D setup: companion within resource reach of the tree", await teleport(rcon, nearest.x + 1.5, nearest.y), JSON.stringify(nearest));

      const start = await callTool(mcp.client, "resource_mine", {
        companionId: ID, x: nearest.x, y: nearest.y, count: target, resourceName: "wood"
      });
      console.log("resource_mine(wood) ->", JSON.stringify(start));
      check("D1: harvest started (pre-0.18.0 replied {error:'No resource'})", start?.mining === true, JSON.stringify(start));

      const result = await awaitHarvest(rcon, 30000);
      console.log("terminal harvest status ->", JSON.stringify(result));
      check("D2: queue TERMINATED rather than hanging", result?.timedOut !== true, JSON.stringify(result));
      check("D3: terminal reason is target_reached", result?.reason === "target_reached", `reason=${result?.reason}`);

      const after = await invCount(rcon, "wood");
      check("D4: wood actually entered the inventory", after - before >= target, `before=${before} after=${after} target=${target}`);
      check("D5: counted `harvested` equals the real inventory delta", result?.harvested === after - before, `harvested=${result?.harvested} delta=${after - before}`);
    });

    await section("E", "regressions across the shared filter path", async () => {
      const w = await callTool(mcp.client, "world_nearest", { companionId: ID, entityName: "wood" });
      check("E1: world_nearest tree branch survives losing its private alias table", !!w?.position && typeof w.distance === "number", JSON.stringify(w));
      const water = await callTool(mcp.client, "world_nearest", { companionId: ID, entityName: "water" });
      check("E2: world_nearest water branch still answers", !!water?.position || water?.error === "Not found", JSON.stringify(water));

      // Two DIFFERENT absence paths, and they are meant to read differently:
      //   unknown prototype -> find_entities_filtered raises, u.safe_command turns it into a
      //     descriptive "Unknown entity name" error. Better than "Not found": it tells a caller
      //     it made a typo rather than that the map is bare.
      //   valid prototype, none in range -> the search completes empty -> "Not found".
      const bogus = await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "definitely-not-a-thing" });
      check("E3: unknown token yields a descriptive error, not a hang or a bare throw", typeof bogus?.error === "string" && /unknown entity name/i.test(bogus.error), JSON.stringify(bogus));

      const absent = await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "uranium-ore" });
      check("E3b: a valid prototype with none in range reports Not found", absent?.error === "Not found" || !!absent?.position, JSON.stringify(absent));

      // Ore mining still works: the token now routes through u.resource_filter too.
      const coal = await callTool(mcp.client, "resource_nearest", { companionId: ID, resourceType: "coal" });
      if (coal?.position) {
        check("E setup: teleported to the coal", await teleport(rcon, coal.position.x + 1.5, coal.position.y), JSON.stringify(coal.position));
        const beforeCoal = await invCount(rcon, "coal");
        const startCoal = await callTool(mcp.client, "resource_mine", {
          companionId: ID, x: coal.position.x, y: coal.position.y, count: 3, resourceName: "coal"
        });
        check("E4: ore harvest still starts", startCoal?.mining === true, JSON.stringify(startCoal));
        const res = await awaitHarvest(rcon, 30000);
        check("E5: ore harvest still terminates with target_reached", res?.reason === "target_reached", JSON.stringify(res));
        check("E6: ore actually entered the inventory", (await invCount(rcon, "coal")) - beforeCoal >= 3, `delta=${(await invCount(rcon, "coal")) - beforeCoal}`);
      } else {
        check("E4-E6: coal reachable for the ore regression", false, "no coal found - ore regression not exercised");
      }
    });
  } finally {
    // Teardown keys on exact POSITION - trees have no useful unit_number, and an id-keyed
    // teardown silently no-ops, leaving the planted arena standing in the live world.
    try {
      const destroyed = await destroyTrees(rcon, planted);
      console.log(`\nTeardown: destroyed ${destroyed}/${planted.length} planted trees`);
      if (arena) {
        console.log(`Teardown: swept ${await sweepGround(rcon, arena)} ground items at the arena`);
      }
      const pos = await companionPos(rcon).catch(() => null);
      await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
      // disappear spills the companion's inventory with enable_looted, so clean up after it.
      if (pos) console.log(`Teardown: swept ${await sweepGround(rcon, pos)} spilled items at the companion`);
      const left = await lua(rcon, `
        local s = game.surfaces[1]
        local n = 0
        for _, p in ipairs({${planted.map((p) => `{x = ${p.x}, y = ${p.y}}`).join(", ")}}) do
          n = n + #s.find_entities_filtered{position = p, radius = 0.6, type = "tree"}
        end
        rcon.print(helpers.table_to_json({remaining = n}))
      `).catch(() => ({ remaining: -1 }));
      check("teardown: no planted tree left standing in the world", left.remaining === 0, `remaining=${left.remaining}`);
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
