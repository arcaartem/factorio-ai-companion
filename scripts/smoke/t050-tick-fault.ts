// Live smoke test for T-050: protect the on_nth_tick queue handlers (factorio-mod/control.lua,
// commands/init.lua, commands/queues.lua) from an unprotected raise taking the whole mod down,
// and record the outcome before a faulted queue entry is deleted - same "outcome before
// deletion" rule the mod already follows for target_reached/too_far/blocked/etc.
//
// This suite covers what is REACHABLE through the live command surface. Containment of an
// actual raise is NOT reachable that way (see "Fault-injection reachability" below) and is
// covered by section 4, which is inert unless T050_FAULT_PATCH=1 AND the temporary patch is
// applied. That probe HAS been run - see "RESULT of that probe" below - but a green run of this
// file WITHOUT the env var is not evidence of it, and never will be.
//
// ============================================================================================
// Fault-injection reachability (investigated, not just asserted)
// ============================================================================================
// /silent-command runs in the level script context and cannot see storage.companions or any
// mod storage table (CLAUDE.md) - so no side-channel command can corrupt a queue entry's
// internal fields (q.recipe, q.entity, q.current, ...) to force one of the five tick
// processors down an error path. Every entity handle each processor touches is re-validated
// with .valid immediately before use, and the remaining raise-shaped API calls either return a
// sentinel failure value rather than raising (begin_crafting, create_entity's can_place_entity
// pre-check) or are already wrapped in a local pcall (request_path in queues.lua's
// request_path(), and now tick_build_queues' create_entity call, both pre-existing/added by
// this same card). I could not construct a live, legitimate-command-plus-side-channel sequence
// that forces a raise out of any of the five tick functions.
//
// Conclusion: NOT reachable through legitimate commands + side-channel world manipulation, as
// far as static analysis plus the checks above can show. Proving the containment path itself
// (process_queue's per-entry pcall, forced removal, and each queue's on_error -> *_results
// write) therefore needs the documented temporary-patch approach: a one-line uncommitted raise
// inserted into one queue's processor in commands/queues.lua (e.g. `error("t050 fault")` as the
// first line of tick_craft_queues' processor), run this suite (or a poll loop) against the
// patched mod to confirm (a) the mod keeps running - other companions/queues are unaffected,
// (b) the matching *_status command reports reason="error" with the message, then revert the
// patch and re-run to confirm no regression. I did NOT run this myself - per the brief I am not
// to run scripts/smoke/test-server.ts (shared mods dir, other agents concurrently editing).
// The coordinator should run that patch-and-revert probe before treating containment as proven
// end-to-end; this file only proves the reachable half.
//
// ============================================================================================
// What this suite DOES assert (all reachable through real commands, no patch needed)
// ============================================================================================
// The craft queue's storage.craft_results is new in this card - before it, get_craft_status
// returned a bare {active:false} on completion, success or failure indistinguishable from
// "never ran". Sections 1-3 below are the regression coverage for that widening:
//   1. target_reached  - normal completion, crafted === target, reason recorded.
//   2. missing_ingredients - ingredients spent out from under the running queue by a REALISTIC
//      synchronous craft (same idiom as t043's conjure section - not side-channel item
//      destruction), so the queue's next tick finds begin_crafting returning 0. Before this
//      card this path recorded NOTHING at all (a silent `return true`).
//   3. stopped - item_craft_stop still records a reason, now inspectable via a status poll
//      after the stop instead of only via the stop call's own one-shot response.
//
// harvest/build/combat (finish_harvest/finish_build/finish_combat) only gained a new trailing
// optional `err` parameter, nil at every existing non-error call site - their normal-path
// behavior is unchanged and already covered live by t031 (harvest), t043 (build) and
// t051/t021 (combat); this suite does not duplicate that coverage.
//
// ============================================================================================
// Section 4 (poison-entry containment) needs the temporary patch - exact instructions
// ============================================================================================
// Section 4 asserts the property process_queue's fix exists for: a raise inside ONE
// companion's queue entry (or its on_error/on_drop recorder) must not stop process_queue's
// trailing removal loop for every OTHER entry queued on the same tick (see the comment above
// process_queue in queues.lua). This is not reachable without an artificial raise - see
// "Fault-injection reachability" above - so section 4 is gated behind the T050_FAULT_PATCH=1
// environment variable and is a SKIPPED no-op (contributes zero checks, pass or fail) without
// it. Do not read a green run of this file without that variable as proof section 4 passed.
//
// To exercise it, apply this UNCOMMITTED one-line patch to commands/queues.lua, deploy, run
// this suite with the env var set, then REVERT the patch, redeploy, and run the suite again
// (without the env var) to confirm sections 1-3 are unaffected:
//
//   function M.tick_craft_queues()
//     process_queue("craft_queues", function(cid, q, c)
//   +   if cid == 50 then error("t050 fault") end -- TEMPORARY - DO NOT COMMIT
//       local elapsed = game.tick - q.tick_start
//       ...
//
// cid == 50 is FAULT_ID below; the raise fires unconditionally on every tick companion 50's
// queue entry exists, before any of the processor's own logic, so its entry is removed on the
// very first on_nth_tick(5) evaluation after item_craft_start. Companion 51 (CONTROL_ID) crafts
// concurrently in the SAME storage.craft_queues table and must still complete normally on its
// own schedule despite 50 raising every tick it exists - that is the property under test.
//
//   T050_FAULT_PATCH=1 bun run scripts/smoke/test-server.ts t050
//
// Sections 1-3 are SKIPPED under T050_FAULT_PATCH=1, because the patch keys on cid == 50 and
// that is their own subject - they cannot pass under it by construction. Skipping them keeps
// the patched run readable rather than reporting six reds a reader has to reconstruct.
//
// ============================================================================================
// RESULT of that probe, run 2026-07-29 by the coordinator (both patches, then reverted)
// ============================================================================================
// PATCH A (processor raises, as written above): 11/11. The faulted entry resolved to
// {active:false, crafted:0, reason:"error", error:"__ai-companion__/commands/queues.lua:648:
// t050 fault"}, was still active:false on a later re-poll (so it did not re-run), and companion
// 51 - crafting concurrently in the SAME storage.craft_queues table - completed normally with
// reason "target_reached", crafted === target === 1. That last part is the poison-entry
// property: before per-entry scoping, one raising cid aborted the pairs() walk.
//
// PATCH B (a SECOND uncommitted patch, `if cid == 50 then error("t050 RECORDER fault") end` as
// the first line of the craft on_error handler, so the processor AND its recorder both raise):
// 8/11, and the three reds are correct. 4.3/4.4/4.6 fail because no reason could be recorded -
// the recorder itself was broken, which is the point. What matters is what still held:
// 4.2 the entry was STILL REMOVED ({active:false}), 4.5 it did not re-run, and 4.7-4.9 the
// control companion still completed normally, i.e. process_queue's trailing removal loop still
// ran for every other entry on that tick.
//
// Patch B is the regression test for the review defect this card's first implementation had:
// on_error ran BEFORE the to_remove append and was itself unprotected, so a raise inside the
// recorder skipped the removal AND the whole trailing deletion loop - reinstating the per-5-tick
// drain loop inside the handler meant to contain it. Under that version, 4.2 would have shown a
// queue that never resolved and 4.7-4.9 would have failed too. Re-run BOTH patches if
// process_queue's error branch is ever restructured; patch A alone does not cover it.
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t050-tick-fault.ts
// Prefer the disposable headless server, which guarantees fresh mod code:
//   bun run scripts/smoke/test-server.ts t050
import { connectMCP, connectRCON, callTool, check, summary, silent } from "./lib";

const ID = 50;
const CONTROL_ID = 51; // section 4 only
const FAULT_MODE = process.env.T050_FAULT_PATCH === "1"; // section 4 only - see header
// ticks_per = max(MIN_ACTION_TICKS=30, recipe.energy*60); iron-gear-wheel's energy is 0.5s ->
// 30 ticks either way, i.e. ~0.5s at 60 UPS. Poll generously past that for a slower test server.
const POLL_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 200;

type RCON = { send: (cmd: string) => Promise<string> };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** silent() returns raw text; every probe here answers with one helpers.table_to_json line. */
async function lua(rcon: RCON, body: string): Promise<any> {
  const raw = await silent(rcon, body);
  const line = raw.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`no JSON in RCON reply: ${raw.slice(0, 300)}`);
  return JSON.parse(line);
}

/** /fac_companion_position is a real mod command (unlike /silent-command it CAN see storage). */
async function companionPos(rcon: RCON, id: number): Promise<{ x: number; y: number }> {
  const raw = await rcon.send(`/fac_companion_position ${id}`);
  const d = JSON.parse(raw.split("\n").find((l) => l.trim().startsWith("{"))!);
  if (!d?.position) throw new Error(`companion ${id} has no position: ${raw}`);
  return d.position;
}

/** storage.companions is unreachable from /silent-command, so the companion is identified by
 *  matching a character with no player near its LAST KNOWN position (from the real command
 *  above) - same idiom t043 uses. */
function nearestCompanionLua(pos: { x: number; y: number }, varName = "best"): string {
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

/** Sanctioned in harnesses only (T-019/T-037/T-042/T-043 precedent): sets the companion's
 *  main-inventory count of ONE item to exactly `count`, removing whatever it already held
 *  first. Returns the verified count. */
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

async function invCount(rcon: RCON, id: number, item: string): Promise<number> {
  const raw = await rcon.send(`/fac_companion_inventory ${id}`);
  const d = JSON.parse(raw.split("\n").find((l) => l.trim().startsWith("{"))!);
  const items = Array.isArray(d?.items) ? d.items : [];
  return items.find((i: any) => i.name === item)?.count ?? 0;
}

/** Drains the CHARACTER's own crafting queue to empty.
 *
 *  The mod's craft queue and the character's crafting queue are different things, and the first
 *  live run of this suite tripped over the gap: item_craft_status reported
 *  {crafted:2, target:2, reason:"target_reached"} and iron-plate had correctly gone 4 -> 0, yet
 *  the companion held only 1 iron-gear-wheel. Nothing was wrong with the mod. begin_crafting
 *  debits ingredients UP FRONT and delivers products one craft at a time, so q.crafted counts
 *  crafts QUEUED, not items produced (see the item_craft note in CLAUDE.md) - reading inventory
 *  the moment the mod's queue resolves races delivery of the last craft. Poll
 *  LuaControl.crafting_queue_size to 0 before asserting on products. */
async function waitForCraftDrain(rcon: RCON, id: number): Promise<number> {
  const cur = await companionPos(rcon, id);
  const started = Date.now();
  let size = -1;
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const r = await lua(rcon, `
      ${nearestCompanionLua(cur)}
      if not best then rcon.print(helpers.table_to_json({ok = false})) return end
      rcon.print(helpers.table_to_json({ok = true, size = best.crafting_queue_size or 0}))
    `);
    if (!r.ok) throw new Error(`could not locate companion ${id} to read crafting_queue_size`);
    size = r.size;
    if (size === 0) return size;
    await sleep(POLL_INTERVAL_MS);
  }
  return size;
}

/** Polls item_craft_status until the async queue resolves (status.active === false) or the
 *  timeout elapses. Returns the LAST status seen either way - a caller asserting on a
 *  still-active status after timeout fails with a legible reason rather than throwing here. */
async function pollCraftStatus(mcp: { client: any }, id: number): Promise<any> {
  const start = Date.now();
  let status: any;
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const res = await callTool(mcp.client, "item_craft_status", { companionId: id });
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

/** Sections 1-3 exercise companion 50's craft queue, and the section-4 fault patch keys on
 *  `cid == 50` — so under T050_FAULT_PATCH=1 those sections CANNOT pass: their subject is
 *  deliberately poisoned. Skip them explicitly rather than letting them report six red
 *  assertions whose redness is only explainable out-of-band. A partially-red suite is not
 *  "mostly verified" — it is a run nobody can read — and a reader six months from now must not
 *  have to reconstruct which failures were intentional. */
async function faultSkip(label: string, banner: string): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  console.log(
    `SKIPPED (contributes zero checks): T050_FAULT_PATCH=1 poisons companion ${ID}, which is ` +
    `this section's own subject, so it cannot pass under the patch by construction. Run without ` +
    `the env var (and with the patch reverted) for sections 1-3.`
  );
}

async function main(): Promise<void> {
  const mcp = await connectMCP();
  const rcon = await connectRCON();

  try {
    console.log("=== Setup: spawn companion 50 ===");
    await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
    const spawn = await callTool(mcp.client, "companion_spawn", { companionId: ID });
    console.log("companion_spawn(50) ->", JSON.stringify(spawn));
    check("setup: companion 50 spawned (not a stale 'exists')", spawn?.spawned === true, JSON.stringify(spawn));
    if (spawn?.spawned !== true) throw new Error("cannot proceed without a fresh companion");

    // ================================================================================
    if (FAULT_MODE) await faultSkip("1", "craft target_reached - proves craft_results now records normal completion");
    else await section("1", "craft target_reached - proves craft_results now records normal completion", async () => {
      // 2 iron-plate per iron-gear-wheel; 4 plates => craftable = 2 => target = 2.
      await setCompanionItems(rcon, ID, "iron-plate", 4);
      await setCompanionItems(rcon, ID, "iron-gear-wheel", 0);
      const before = await invCount(rcon, ID, "iron-plate");
      check("1 setup: companion holds 4 iron-plate", before === 4, `have=${before}`);
      if (before !== 4) return;

      const start = await callTool(mcp.client, "item_craft_start", { companionId: ID, recipe: "iron-gear-wheel", count: 2 });
      console.log("item_craft_start ->", JSON.stringify(start));
      check("1.1: queue accepted (started === true, target === 2)", start?.started === true && start?.target === 2, JSON.stringify(start));
      if (start?.started !== true) return;

      const status = await pollCraftStatus(mcp, ID);
      console.log("item_craft_status (resolved) ->", JSON.stringify(status));
      check("1.2: queue resolved (active === false) within the poll window", status?.active === false, JSON.stringify(status));
      check("1.3 DECISIVE (new behavior): reason === 'target_reached'", status?.reason === "target_reached", JSON.stringify(status));
      check("1.4 DECISIVE: crafted === target === 2", status?.crafted === 2 && status?.target === 2, JSON.stringify(status));
      check("1.5: error is absent on a normal completion", status?.error === undefined || status?.error === null, JSON.stringify(status));

      // The mod's queue being done means all 2 crafts were QUEUED, not delivered - wait for the
      // character's own crafting queue before reading products. See waitForCraftDrain.
      const remaining = await waitForCraftDrain(rcon, ID);
      check("1.6 setup: character's crafting queue drained to 0", remaining === 0, `crafting_queue_size=${remaining}`);
      const gears = await invCount(rcon, ID, "iron-gear-wheel");
      check("1.7 DECISIVE: companion actually holds 2 iron-gear-wheel", gears === 2, `have=${gears}`);
      const plates = await invCount(rcon, ID, "iron-plate");
      check("1.8 DECISIVE: iron-plate fully consumed (0 left)", plates === 0, `have=${plates}`);
    });

    // ================================================================================
    if (FAULT_MODE) await faultSkip("2", "craft missing_ingredients - ingredients spent out from under the running queue");
    else await section("2", "craft missing_ingredients - ingredients spent out from under the running queue", async () => {
      // Same realistic-race idiom as t043's conjure section: spend the ingredient via a
      // REAL synchronous command inside the async queue's ~0.5s window, not side-channel
      // destruction. Before this card, this path recorded nothing at all (bare `return true`).
      await setCompanionItems(rcon, ID, "iron-plate", 4);
      await setCompanionItems(rcon, ID, "iron-gear-wheel", 0);
      const before = await invCount(rcon, ID, "iron-plate");
      check("2 setup: companion holds 4 iron-plate", before === 4, `have=${before}`);
      if (before !== 4) return;

      const start = await callTool(mcp.client, "item_craft_start", { companionId: ID, recipe: "iron-gear-wheel", count: 2 });
      console.log("item_craft_start ->", JSON.stringify(start));
      check("2.1: queue accepted (started === true, target === 2)", start?.started === true && start?.target === 2, JSON.stringify(start));
      if (start?.started !== true) return;

      // Drain the SAME 4 iron-plate synchronously, immediately (well inside the ~30-tick/0.5s
      // window) - begin_crafting debits ingredients up front (CLAUDE.md), so this leaves the
      // async queue with zero iron-plate by the time its first tick fires.
      const sync = await callTool(mcp.client, "item_craft", { companionId: ID, recipe: "iron-gear-wheel", count: 2 });
      console.log("item_craft(synchronous drain) ->", JSON.stringify(sync));
      check("2.2 setup: the synchronous craft succeeded, draining the ingredients", sync?.crafted === 2, JSON.stringify(sync));
      if (sync?.crafted !== 2) return;

      const midPlates = await invCount(rcon, ID, "iron-plate");
      check("2.3 setup: iron-plate is now 0 (spent by the synchronous craft)", midPlates === 0, `have=${midPlates}`);

      const status = await pollCraftStatus(mcp, ID);
      console.log("item_craft_status (resolved) ->", JSON.stringify(status));
      check("2.4: queue resolved (active === false) within the poll window", status?.active === false, JSON.stringify(status));
      check("2.5 DECISIVE (new behavior): reason === 'missing_ingredients'", status?.reason === "missing_ingredients", JSON.stringify(status));
      check("2.6 DECISIVE: crafted === 0 (the async queue never got a chance to run)", status?.crafted === 0, JSON.stringify(status));
      check("2.7: target still reports the original request (2)", status?.target === 2, JSON.stringify(status));
    });

    // ================================================================================
    if (FAULT_MODE) await faultSkip("3", "craft stopped - item_craft_stop's outcome is now readable via a later status poll");
    else await section("3", "craft stopped - item_craft_stop's outcome is now readable via a later status poll", async () => {
      // Recipe.energy floors ticks_per at MIN_ACTION_TICKS (30) regardless, so a large target
      // guarantees the queue is still active when the stop below fires.
      await setCompanionItems(rcon, ID, "iron-plate", 20);
      await setCompanionItems(rcon, ID, "iron-gear-wheel", 0);
      const before = await invCount(rcon, ID, "iron-plate");
      check("3 setup: companion holds 20 iron-plate", before === 20, `have=${before}`);
      if (before !== 20) return;

      const start = await callTool(mcp.client, "item_craft_start", { companionId: ID, recipe: "iron-gear-wheel", count: 10 });
      console.log("item_craft_start ->", JSON.stringify(start));
      check("3.1: queue accepted (started === true, target === 10)", start?.started === true && start?.target === 10, JSON.stringify(start));
      if (start?.started !== true) return;

      const stop = await callTool(mcp.client, "item_craft_stop", { companionId: ID });
      console.log("item_craft_stop ->", JSON.stringify(stop));
      check("3.2: stop reports stopped === true", stop?.stopped === true, JSON.stringify(stop));

      // A poll AFTER the stop - the assertion that proves the outcome is reachable through the
      // matching *_status command, not just the one-shot stop response.
      const status = await callTool(mcp.client, "item_craft_status", { companionId: ID });
      console.log("item_craft_status (after stop) ->", JSON.stringify(status?.status));
      check("3.3: status reports active === false", status?.status?.active === false, JSON.stringify(status));
      check("3.4 DECISIVE (new behavior): reason === 'stopped'", status?.status?.reason === "stopped", JSON.stringify(status));
      check("3.5: crafted matches what the stop call itself reported", status?.status?.crafted === stop?.crafted, JSON.stringify({ stop, status }));
    });

    // ================================================================================
    await section(
      "4",
      "poison-entry containment - a raise on ONE companion's queue entry must not block another's on the same tick",
      async () => {
        if (!FAULT_MODE) {
          console.log(
            "SKIPPED (informational, contributes zero checks): requires the temporary fault patch - " +
              "see the file header ('Section 4 ... needs the temporary patch') for the exact patch and " +
              "T050_FAULT_PATCH=1 env var. A green run WITHOUT that variable is not evidence this section passed."
          );
          return;
        }

        await callTool(mcp.client, "companion_disappear", { companionId: CONTROL_ID }).catch(() => {});
        const controlSpawn = await callTool(mcp.client, "companion_spawn", { companionId: CONTROL_ID });
        console.log(`companion_spawn(${CONTROL_ID}) ->`, JSON.stringify(controlSpawn));
        check("4 setup: control companion (51) spawned", controlSpawn?.spawned === true, JSON.stringify(controlSpawn));
        if (controlSpawn?.spawned !== true) return;

        // Small, identical, one-craft targets on both companions - just enough ingredients for
        // exactly one iron-gear-wheel each - so both queue entries share storage.craft_queues
        // at the same time under the patched mod's forced every-tick raise on FAULT_ID (50).
        await setCompanionItems(rcon, ID, "iron-plate", 2);
        await setCompanionItems(rcon, ID, "iron-gear-wheel", 0);
        await setCompanionItems(rcon, CONTROL_ID, "iron-plate", 2);
        await setCompanionItems(rcon, CONTROL_ID, "iron-gear-wheel", 0);

        const faultStart = await callTool(mcp.client, "item_craft_start", { companionId: ID, recipe: "iron-gear-wheel", count: 1 });
        const controlStart = await callTool(mcp.client, "item_craft_start", { companionId: CONTROL_ID, recipe: "iron-gear-wheel", count: 1 });
        console.log("fault(50) item_craft_start ->", JSON.stringify(faultStart));
        console.log("control(51) item_craft_start ->", JSON.stringify(controlStart));
        check("4.1: both queues accepted", faultStart?.started === true && controlStart?.started === true, JSON.stringify({ faultStart, controlStart }));
        if (faultStart?.started !== true || controlStart?.started !== true) return;

        const faultStatus = await pollCraftStatus(mcp, ID);
        console.log("fault(50) item_craft_status (resolved) ->", JSON.stringify(faultStatus));
        check("4.2 DECISIVE: fault companion's queue resolved (active === false)", faultStatus?.active === false, JSON.stringify(faultStatus));
        check("4.3 DECISIVE: reason === 'error'", faultStatus?.reason === "error", JSON.stringify(faultStatus));
        check(
          "4.4 DECISIVE: error message contains the patch's marker string",
          typeof faultStatus?.error === "string" && faultStatus.error.includes("t050 fault"),
          JSON.stringify(faultStatus)
        );

        // Re-poll after a further delay: the entry must stay gone, not resurrect or re-run -
        // the recorded error must be identical to the first poll, not a fresh one.
        await sleep(1000);
        const faultAgain = await callTool(mcp.client, "item_craft_status", { companionId: ID });
        console.log("fault(50) item_craft_status (re-poll) ->", JSON.stringify(faultAgain?.status));
        check("4.5 DECISIVE: still active === false on a later poll (did not re-run)", faultAgain?.status?.active === false, JSON.stringify(faultAgain));
        check(
          "4.6 DECISIVE: reason still 'error', same recorded message (no repeated re-processing)",
          faultAgain?.status?.reason === "error" && faultAgain?.status?.error === faultStatus?.error,
          JSON.stringify({ first: faultStatus, again: faultAgain?.status })
        );

        // The poison-entry-starvation property itself: companion 51 shares the SAME
        // storage.craft_queues table and must still be processed and removed NORMALLY despite
        // 50 raising on every tick it existed.
        const controlStatus = await pollCraftStatus(mcp, CONTROL_ID);
        console.log("control(51) item_craft_status (resolved) ->", JSON.stringify(controlStatus));
        check(
          "4.7 DECISIVE (the poison-entry property): control companion's queue resolved (active === false)",
          controlStatus?.active === false,
          JSON.stringify(controlStatus)
        );
        check("4.8 DECISIVE: control companion completed NORMALLY (reason === 'target_reached')", controlStatus?.reason === "target_reached", JSON.stringify(controlStatus));
        check(
          "4.9 DECISIVE: control companion actually crafted (crafted === target === 1)",
          controlStatus?.crafted === 1 && controlStatus?.target === 1,
          JSON.stringify(controlStatus)
        );
      }
    );
  } finally {
    console.log("\n--- Teardown ---");
    try {
      await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
      await callTool(mcp.client, "companion_disappear", { companionId: CONTROL_ID }).catch(() => {});
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
