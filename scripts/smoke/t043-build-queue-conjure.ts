// Live smoke test for T-043 (mod 0.20.4): M.tick_build_queues (factorio-mod/commands/queues.lua)
// used to create_entity FIRST and inv.remove{...} SECOND with the return value discarded, so an
// item spent (by any other means) during the ~60-tick queue window still yielded the building
// with nothing debited - two entities from one item.
//
// Contract under test (frozen spec for this suite - see the T-043 batch): at execution time
// M.tick_build_queues now re-validates in this order and debits BEFORE creating:
//   1. reach re-check (against the companion's position AT RESOLUTION TIME, not queue time)
//      -> on failure reason = "too_far", nothing created, item NOT consumed.
//   2. can_place_entity re-check -> on failure reason = "blocked", nothing created, item NOT
//      consumed.
//   3. inv.remove{count = 1} on defines.inventory.character_main, return value checked -> if
//      < 1, reason = "no_item", nothing created.
//   4. create_entity -> reason = "placed".
//   5. create_entity nil despite the checks above -> the debited item is refunded via
//      inv.insert, reason = "blocked".
//
// storage.build_results[cid] shape (unchanged): {placed, entity, position, requested, reason,
// tick}. The MCP tool building_place_status nests it: {id, status: {active, placed, entity,
// position, requested, reason}} - NOT the flat shape harvest/combat status use. building_place_
// start returns {id, started, entity, position}.
//
// BUILD_TICKS = 60, driven by script.on_nth_tick(5) - the queue resolves on the first
// on_nth_tick(5) firing at or after tick_start + 60, i.e. worst case ~64 ticks (~1.07s at 60
// UPS). This suite polls building_place_status rather than sleeping a fixed amount, since the
// disposable test server and an interactively-hosted game are not guaranteed to run at the same
// wall-clock speed.
//
// Sections (companion 44):
//   0. preflight - reads /fac_version. NOT authoritative (CLAUDE.md: info.json/active_mods are
//      pinned at application startup and have read stale before) - logged for convenience only,
//      never gates the run. The real freshness proof is section 2 passing at all.
//   1. happy path - proves the fix didn't break placing at all.
//   2. THE CONJURE REGRESSION (this card's Done-when) - spend the queued item synchronously
//      inside the window and prove only one entity results.
//   3. reach re-check - teleport the companion away inside the window.
//   4. blocked re-check - obstruct the tile inside the window, item must survive.
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t043-build-queue-conjure.ts
// Prefer the disposable headless server, which guarantees fresh mod code:
//   bun run scripts/smoke/test-server.ts t043
import { connectMCP, connectRCON, callTool, check, summary, silent } from "./lib";

const ID = 44;
// BUILD_TICKS(60)/60 UPS ~= 1s; poll generously past that so a slower test server doesn't
// produce a false "still active" failure.
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

/** storage.companions is unreachable from /silent-command, so the companion is identified by
 *  matching a character with no player near its LAST KNOWN position (from the real command
 *  above). */
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
 *  arena setup is allowed to conjure items directly (T-019/T-037/T-042 precedent).
 *
 *  Sets the companion's main-inventory count of ONE item to exactly `count`, removing whatever it
 *  already held first. Sections must reset absolutely rather than add: this suite's first live run
 *  reported section 2 red against WORKING code because section 1's two leftover furnaces meant the
 *  queued build fired with items in hand and correctly answered "placed" - the zero-item path the
 *  section asserts on was never created. Removing only this item name (not inv.clear()) keeps the
 *  companion's weapon/ammo slots and any other setup untouched. Returns the verified count. */
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
 *  timeout elapses. Returns the LAST status seen either way - a caller asserting on a
 *  still-active status after timeout fails with a legible reason rather than throwing here. */
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
    console.log("=== Setup: spawn companion 44 ===");
    await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
    const spawn = await callTool(mcp.client, "companion_spawn", { companionId: ID });
    console.log("companion_spawn(44) ->", JSON.stringify(spawn));
    check("setup: companion 44 spawned (not a stale 'exists')", spawn?.spawned === true, JSON.stringify(spawn));
    if (spawn?.spawned !== true) throw new Error("cannot proceed without a fresh companion");

    // ================================================================================
    await section("0", "preflight - deployed mod version (convenience label only, NOT proof of running code)", async () => {
      const v = await callTool(mcp.client, "version", {});
      console.log("version ->", JSON.stringify(v));
      // info.json / script.active_mods is pinned at application startup (CLAUDE.md: it has read
      // stale before, e.g. 0.13.3 while current code ran). This is logged for triage convenience
      // and does NOT gate the suite - section 2 passing is the actual freshness proof, since the
      // pre-fix code could not pass it.
      check("0: /fac_version reports 0.20.4 (informational - not gating)", v?.version === "0.20.4", `got ${JSON.stringify(v)} - a mismatch here is a hint, not a failure cause; trust section 2 instead`);
    });

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
    // stone-furnace is 2x2 (even both dimensions), so it snaps to an integer-coordinate tile
    // centre - request integer coordinates throughout to avoid an unrelated snap surprise.
    const baseX = Math.floor(base.x);
    const baseY = Math.floor(base.y);
    console.log("Base arena anchor ->", JSON.stringify({ x: baseX, y: baseY }));

    // ================================================================================
    await section("1", "happy path - proves the fix didn't break placing", async () => {
      const arena = { x: baseX, y: baseY };
      await teleportCompanion(rcon, ID, arena.x, arena.y);
      const target = { x: arena.x + 3, y: arena.y };

      const N = 3;
      await setCompanionItems(rcon, ID, "stone-furnace", N);
      const before = await invCount(rcon, ID, "stone-furnace");
      check("1 setup: companion holds N stone-furnaces", before === N, `have=${before}`);
      // A broken premise must abort the section, never run the DECISIVE assertions on top of it:
      // every assertion after a failed setup is UNKNOWN, not passing.
      if (before !== N) return;

      const start = await callTool(mcp.client, "building_place_start", { companionId: ID, entityName: "stone-furnace", x: target.x, y: target.y, direction: 0 });
      console.log("building_place_start ->", JSON.stringify(start));
      check("1.1: queue accepted (started === true)", start?.started === true, JSON.stringify(start));
      if (start?.started !== true) return;

      const status = await pollBuildStatus(mcp, ID);
      console.log("building_place_status (resolved) ->", JSON.stringify(status));
      check("1.2: queue resolved (active === false) within the poll window", status?.active === false, JSON.stringify(status));
      check("1.3: placed === true", status?.placed === true, JSON.stringify(status));
      check("1.4: reason === 'placed'", status?.reason === "placed", JSON.stringify(status));
      if (status?.placed !== true) return;

      const after = await invCount(rcon, ID, "stone-furnace");
      check("1.5 DECISIVE: main inventory holds exactly N-1", after === N - 1, `before=${before} after=${after} expected=${N - 1}`);

      const onTarget = await countNear(rcon, "stone-furnace", status.position, 0.6);
      check("1.6 DECISIVE: exactly ONE stone-furnace exists at the reported position", onTarget === 1, `count=${onTarget}`);

      // Destroy it here rather than waiting for final teardown: section 2's arena-wide scan
      // needs a world PROVEN empty of stone-furnace, not one merely assumed empty because
      // nothing else placed one there.
      const removed = await destroyNear(rcon, "stone-furnace", status.position, 1);
      check("1 cleanup: the placed furnace was removed before the next section runs", removed === 1, `removed=${removed}`);
    });

    // ================================================================================
    await section("2", "THE CONJURE REGRESSION - spend the queued item synchronously inside the ~60-tick window", async () => {
      const arena = { x: baseX + 20, y: baseY };
      await teleportCompanion(rcon, ID, arena.x, arena.y);
      const tileA = { x: arena.x + 3, y: arena.y }; // queued build target
      const tileB = { x: arena.x - 3, y: arena.y }; // synchronous build target - a different tile

      await setCompanionItems(rcon, ID, "stone-furnace", 1);
      const before = await invCount(rcon, ID, "stone-furnace");
      check("2 setup: companion holds exactly ONE stone-furnace", before === 1, `have=${before}`);
      if (before !== 1) return;
      const clearA = await countNear(rcon, "stone-furnace", tileA, 1.5);
      const clearB = await countNear(rcon, "stone-furnace", tileB, 1.5);
      check("2 setup: both target tiles start clear", clearA === 0 && clearB === 0, `A=${clearA} B=${clearB}`);
      // Proves the baseline for 2.9's arena-wide tally below, rather than assuming it: if
      // section 1's furnace (or anything else) were still standing within this radius, 2.9
      // could read 2 for a reason that has nothing to do with this section's own fix.
      const arenaBaseline = await countNear(rcon, "stone-furnace", arena, 8);
      check("2 setup: the whole arena (radius 8) starts with ZERO stone-furnace", arenaBaseline === 0, `count=${arenaBaseline}`);
      if (clearA !== 0 || clearB !== 0 || arenaBaseline !== 0) return;

      const start = await callTool(mcp.client, "building_place_start", { companionId: ID, entityName: "stone-furnace", x: tileA.x, y: tileA.y, direction: 0 });
      console.log("building_place_start(tileA, queued) ->", JSON.stringify(start));
      check("2.1: queue accepted (started === true)", start?.started === true, JSON.stringify(start));
      if (start?.started !== true) return;

      // Spend the ONLY item the companion holds via a SYNCHRONOUS place at a DIFFERENT tile,
      // immediately (well inside the 60-tick/~1s window). This is the realistic way an item can
      // vanish out from under a pending queue - no side-channel item destruction involved.
      const sync = await callTool(mcp.client, "building_place", { companionId: ID, entityName: "stone-furnace", x: tileB.x, y: tileB.y, direction: 0 });
      console.log("building_place(tileB, synchronous spend) ->", JSON.stringify(sync));
      check("2.2 setup: the synchronous placement at tileB succeeded, spending the one item", sync?.placed === true, JSON.stringify(sync));
      if (sync?.placed === true) placed.push({ name: "stone-furnace", x: sync.position.x, y: sync.position.y });

      const midInv = await invCount(rcon, ID, "stone-furnace");
      check("2.3 setup: the companion now holds ZERO stone-furnace (spent by the sync placement)", midInv === 0, `have=${midInv}`);

      const status = await pollBuildStatus(mcp, ID);
      console.log("building_place_status(tileA, after window) ->", JSON.stringify(status));
      check("2.4: queue resolved (active === false) within the poll window", status?.active === false, JSON.stringify(status));
      // Before the fix: create_entity ran first and inv.remove{...}'s return was discarded, so
      // this queued build would ALSO have placed - two stone-furnace entities from one item.
      check("2.5 DECISIVE (the fix): placed === false", status?.placed === false, JSON.stringify(status));
      check("2.6 DECISIVE (the fix): reason === 'no_item'", status?.reason === "no_item", JSON.stringify(status));

      const afterInv = await invCount(rcon, ID, "stone-furnace");
      check("2.7 DECISIVE: main inventory is still 0 (nothing refunded, nothing extra consumed)", afterInv === 0, `have=${afterInv}`);

      const atTileA = await countNear(rcon, "stone-furnace", tileA, 0.6);
      check("2.8 DECISIVE: the queued position (tileA) has NO entity", atTileA === 0, `count=${atTileA}`);

      // Whole-arena tally, not just tileA: this is the assertion that would have caught the old
      // bug even if it had (by luck) reported the queue's own position wrong - count everything
      // stone-furnace-shaped across BOTH tiles and expect exactly the one synchronous placement.
      const wholeArena = await countNear(rcon, "stone-furnace", arena, 8);
      check("2.9 DECISIVE: exactly ONE stone-furnace exists in the whole arena (the synchronous one, not two)", wholeArena === 1, `count=${wholeArena}`);
    });

    // ================================================================================
    await section("3", "reach re-check - teleport the companion away inside the window", async () => {
      const arena = { x: baseX + 40, y: baseY };
      await teleportCompanion(rcon, ID, arena.x, arena.y);
      const tileC = { x: arena.x + 3, y: arena.y };

      await setCompanionItems(rcon, ID, "stone-furnace", 1);
      const before = await invCount(rcon, ID, "stone-furnace");
      check("3 setup: companion holds exactly ONE stone-furnace", before === 1, `have=${before}`);
      if (before !== 1) return;

      const start = await callTool(mcp.client, "building_place_start", { companionId: ID, entityName: "stone-furnace", x: tileC.x, y: tileC.y, direction: 0 });
      console.log("building_place_start(tileC) ->", JSON.stringify(start));
      check("3.1: queue accepted (started === true)", start?.started === true, JSON.stringify(start));
      if (start?.started !== true) return;

      // Teleport well outside build_distance (10) from tileC, immediately, inside the window.
      const farAway = { x: tileC.x + 60, y: tileC.y };
      const teleported = await teleportCompanion(rcon, ID, farAway.x, farAway.y);
      check("3 setup: companion teleported >10 tiles from tileC inside the window", teleported && dist(farAway, tileC) > 10, `dist=${dist(farAway, tileC).toFixed(2)}`);

      const status = await pollBuildStatus(mcp, ID);
      console.log("building_place_status(tileC, after window) ->", JSON.stringify(status));
      check("3.2: queue resolved (active === false) within the poll window", status?.active === false, JSON.stringify(status));
      check("3.3 DECISIVE: placed === false", status?.placed === false, JSON.stringify(status));
      check("3.4 DECISIVE: reason === 'too_far'", status?.reason === "too_far", JSON.stringify(status));

      const atTileC = await countNear(rcon, "stone-furnace", tileC, 0.6);
      check("3.5 DECISIVE: no entity at tileC", atTileC === 0, `count=${atTileC}`);

      // Absolute, not before/after-relative: a relative check ("after === before") is exactly
      // what let section 2's inventory bleed pass unnoticed on a broken premise. `before` is
      // pinned to 1 by this section's own setup guard above, so asserting the literal value
      // catches a bleed that a same-section comparison alone would not.
      const after = await invCount(rcon, ID, "stone-furnace");
      check("3.6 DECISIVE: the item is still in inventory (exactly 1, absolute)", after === 1, `after=${after}`);
    });

    // ================================================================================
    await section("4", "blocked re-check - obstruct the tile inside the window, without destroying the item", async () => {
      const arena = { x: baseX + 60, y: baseY };
      await teleportCompanion(rcon, ID, arena.x, arena.y);
      const tileD = { x: arena.x + 3, y: arena.y };

      await setCompanionItems(rcon, ID, "stone-furnace", 1);
      const before = await invCount(rcon, ID, "stone-furnace");
      check("4 setup: companion holds exactly ONE stone-furnace", before === 1, `have=${before}`);
      if (before !== 1) return;
      const clearD = await countNear(rcon, "stone-furnace", tileD, 1.5);
      check("4 setup: tileD starts clear", clearD === 0, `count=${clearD}`);

      const start = await callTool(mcp.client, "building_place_start", { companionId: ID, entityName: "stone-furnace", x: tileD.x, y: tileD.y, direction: 0 });
      console.log("building_place_start(tileD) ->", JSON.stringify(start));
      check("4.1: queue accepted (started === true)", start?.started === true, JSON.stringify(start));
      if (start?.started !== true) return;

      // Obstruct the SAME tile with the same entity type (so footprint/snap alignment is
      // guaranteed identical), immediately, inside the window.
      const obstruction = await createEntity(rcon, "stone-furnace", tileD);
      console.log("side-channel obstruction ->", JSON.stringify(obstruction));
      check("4 setup: obstruction placed on tileD", obstruction.created === true, JSON.stringify(obstruction));
      if (obstruction.created) placed.push({ name: "stone-furnace", x: obstruction.x, y: obstruction.y });
      if (!obstruction.created) return;

      const status = await pollBuildStatus(mcp, ID);
      console.log("building_place_status(tileD, after window) ->", JSON.stringify(status));
      check("4.2: queue resolved (active === false) within the poll window", status?.active === false, JSON.stringify(status));
      check("4.3 DECISIVE: placed === false", status?.placed === false, JSON.stringify(status));
      check("4.4 DECISIVE: reason === 'blocked'", status?.reason === "blocked", JSON.stringify(status));

      // The assertion that catches a fix trading the conjure bug for a destroy bug: the item
      // must survive a blocked re-check untouched, not vanish into a debit that never refunds.
      // Absolute (exactly 1), not before/after-relative - see section 3's comment on why.
      const after = await invCount(rcon, ID, "stone-furnace");
      check("4.5 DECISIVE: item count is unchanged (exactly 1, absolute - not silently destroyed by the blocked path)", after === 1, `after=${after}`);

      const onTile = await countNear(rcon, "stone-furnace", tileD, 0.6);
      check("4.6 DECISIVE: exactly ONE stone-furnace on tileD (the obstruction, not a second one)", onTile === 1, `count=${onTile}`);
    });
  } finally {
    console.log("\n--- Teardown ---");
    try {
      let destroyed = 0;
      for (const p of placed) {
        destroyed += await destroyNear(rcon, p.name, p, 1);
      }
      console.log(`Teardown: destroyed ${destroyed} entities (of ${placed.length} tracked placements)`);

      const pos = await companionPos(rcon, ID).catch(() => null);
      await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
      // disappear spills the companion's inventory with enable_looted, so clean up after it.
      if (pos) console.log(`Teardown: swept ${await sweepGround(rcon, pos)} spilled items near companion ${ID}`);

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
