// Live smoke test for T-055 (mod 0.21.1): fac_research_set replied `researching` for a technology
// it had only APPENDED behind an already-in-progress one. force.add_research() appends to the
// queue, it never preempts, but the old handler echoed the requested name unconditionally - so a
// caller with research already underway believed the wrong technology was progressing. This cost
// 8 of 10 hand-crafted science packs to the wrong tech in T-002; see the T-055 note in CLAUDE.md.
//
// Every DECISIVE assertion here reads force.current_research / force.research_queue back over the
// RCON side channel (never the command's own reply) - the whole point of the card is a reply that
// lies about which one is true.
//
// Technologies are selected at RUNTIME from force.technologies (not researched, enabled, all
// prerequisites researched), never hard-coded - T-003 burned a probe run on three hard-coded
// names that all turned out already researched in that save, so every add_research() call
// correctly returned false while proving nothing.
//
// Run through the disposable server (reloads by construction, see CLAUDE.md "Preferred loop"):
//   bun run scripts/smoke/test-server.ts t055
//
// Run directly against a live Factorio game + MCP server (repo root as cwd):
//   bun run scripts/smoke/t055-research-queue.ts
import { connectMCP, connectRCON, callTool, check, summary, silent } from "./lib";

const ID = 55;

type RCON = { send: (cmd: string) => Promise<string> };

/** silent() returns raw text; every probe here answers with one helpers.table_to_json line. */
async function lua(rcon: RCON, body: string): Promise<any> {
  const raw = await silent(rcon, body);
  const line = raw.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`no JSON in RCON reply: ${raw.slice(0, 300)}`);
  return JSON.parse(line);
}

/** force.research_queue / force.current_research read back independently - ground truth for
 *  every decisive assertion in this suite, since the reply under test is exactly what's not
 *  trusted here. */
async function queueState(rcon: RCON): Promise<{ current: string | null; queue: string[] }> {
  const r = await lua(rcon, `
    local force = game.players[1].force
    local q = {}
    for i, t in ipairs(force.research_queue) do q[i] = t.name end
    rcon.print(helpers.table_to_json({current = force.current_research and force.current_research.name or nil, queue = q}))
  `);
  // Empty Lua tables serialise as {} not [] (helpers.table_to_json has no array/object
  // distinction) - guard rather than assume queue is always an array.
  return { current: r.current ?? null, queue: Array.isArray(r.queue) ? r.queue : [] };
}

async function resetQueue(rcon: RCON): Promise<void> {
  await lua(rcon, `
    game.players[1].force.research_queue = {}
    rcon.print(helpers.table_to_json({ok = true}))
  `);
}

/** Mirrors fac_research_get's own eligibility filter (not researched, enabled, all prerequisites
 *  researched) so the picks are guaranteed to pass research_set's guards. Sorted for determinism.
 *  Fails loudly rather than skipping silently when the save doesn't have enough candidates. */
async function pickCandidates(rcon: RCON, n: number): Promise<string[]> {
  const r = await lua(rcon, `
    local force = game.players[1].force
    local list = {}
    for name, tech in pairs(force.technologies) do
      if not tech.researched and tech.enabled then
        local can = true
        for _, p in pairs(tech.prerequisites) do if not p.researched then can = false break end end
        if can then list[#list + 1] = name end
      end
    end
    table.sort(list)
    rcon.print(helpers.table_to_json({list = list}))
  `);
  const list: string[] = Array.isArray(r.list) ? r.list : [];
  if (list.length < n) {
    throw new Error(
      `FATAL: need >= ${n} unresearched/enabled/prerequisite-satisfied technologies to run this ` +
      `suite, found ${list.length}: ${JSON.stringify(list)}`
    );
  }
  return list.slice(0, n);
}

/** Harness-sanctioned direct state mutation (see CLAUDE.md's "spawning items and teleporting is
 *  sanctioned in harnesses only" precedent) - this is the only way to reach the "Already done"
 *  guard without actually spending science packs to finish a technology. NOTE: marking a
 *  technology researched applies its unlock effects immediately, and setting `researched` back
 *  to false does NOT revert them - the teardown restores the flag but not any unlocked
 *  recipes/items. Acceptable for a disposable test-server run; a caller running this suite
 *  directly against a real save should be aware of that residue. */
async function setResearched(rcon: RCON, name: string, researched: boolean): Promise<void> {
  await lua(rcon, `
    game.players[1].force.technologies["${name}"].researched = ${researched}
    rcon.print(helpers.table_to_json({ok = true}))
  `);
}

async function section(label: string, banner: string, body: () => Promise<void>): Promise<void> {
  console.log(`\n=== ${label}. ${banner} ===`);
  await body();
}

async function main(): Promise<void> {
  const mcp = await connectMCP();
  const rcon = await connectRCON();
  let markedResearched: string | null = null;

  try {
    console.log("=== Setup: spawn companion 55, reset research queue ===");
    await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
    const spawn = await callTool(mcp.client, "companion_spawn", { companionId: ID });
    console.log("companion_spawn(55) ->", JSON.stringify(spawn));
    check("setup: companion 55 spawned (not a stale 'exists')", spawn?.spawned === true, JSON.stringify(spawn));
    if (spawn?.spawned !== true) throw new Error("cannot proceed without a fresh companion");

    const [techA, techB, techC] = await pickCandidates(rcon, 3);
    console.log("Selected technologies ->", JSON.stringify({ techA, techB, techC }));

    await resetQueue(rcon);
    const resetState = await queueState(rcon);
    check("setup: research queue genuinely empty after reset", resetState.current === null && resetState.queue.length === 0, JSON.stringify(resetState));
    if (!(resetState.current === null && resetState.queue.length === 0)) {
      throw new Error("cannot proceed: research queue would not reset to empty");
    }

    // ================================================================================
    await section("A", "empty queue: research_set makes the technology current", async () => {
      const res = await callTool(mcp.client, "research_set", { companionId: ID, technology: techA });
      console.log(`research_set(${techA}) on empty queue ->`, JSON.stringify(res));
      check("A.1: reply carries researching === techA", res?.researching === techA, JSON.stringify(res));
      check("A.2: reply carries position === 1", res?.position === 1, JSON.stringify(res));
      check("A.3: no `queued` key on this branch", res?.queued === undefined, JSON.stringify(res));

      const truth = await queueState(rcon);
      console.log("side-channel state ->", JSON.stringify(truth));
      check("A.4 DECISIVE: current_research really is techA (side channel)", truth.current === techA, JSON.stringify(truth));
      check("A.5 DECISIVE: queue is exactly [techA]", truth.queue.length === 1 && truth.queue[0] === techA, JSON.stringify(truth));
    });

    // ================================================================================
    await section("B", "non-empty queue: research_set(techB) queues behind the incumbent techA", async () => {
      const res = await callTool(mcp.client, "research_set", { companionId: ID, technology: techB });
      console.log(`research_set(${techB}) behind techA ->`, JSON.stringify(res));
      check("B.1: reply carries queued === techB", res?.queued === techB, JSON.stringify(res));
      check("B.2: reply has NO `researching` key at all", res?.researching === undefined, JSON.stringify(res));
      check("B.3: reply's position is 2", res?.position === 2, JSON.stringify(res));
      check("B.4: reply's current names the incumbent techA", res?.current === techA, JSON.stringify(res));

      const truth = await queueState(rcon);
      console.log("side-channel state ->", JSON.stringify(truth));
      check("B.5 DECISIVE: current_research is STILL techA, not techB", truth.current === techA, JSON.stringify(truth));
      check("B.6 DECISIVE: queue is exactly [techA, techB] in order", truth.queue.length === 2 && truth.queue[0] === techA && truth.queue[1] === techB, JSON.stringify(truth));
    });

    // ================================================================================
    await section("C", "re-adding an already-queued technology reports already_queued truthfully", async () => {
      const beforeState = await queueState(rcon);
      const res = await callTool(mcp.client, "research_set", { companionId: ID, technology: techB });
      console.log(`research_set(${techB}) again ->`, JSON.stringify(res));
      check("C.1: reply carries queued === techB", res?.queued === techB, JSON.stringify(res));
      check("C.2: reply carries already_queued === true (not treated as an error)", res?.already_queued === true, JSON.stringify(res));
      check("C.3: reply's position is unchanged (still 2)", res?.position === 2, JSON.stringify(res));

      const afterState = await queueState(rcon);
      console.log("side-channel state ->", JSON.stringify(afterState));
      check("C.4 DECISIVE: queue length unchanged (still 2, no duplicate entry)", afterState.queue.length === beforeState.queue.length, `before=${JSON.stringify(beforeState)} after=${JSON.stringify(afterState)}`);
      check("C.5 DECISIVE: queue contents unchanged", JSON.stringify(afterState.queue) === JSON.stringify(beforeState.queue), `before=${JSON.stringify(beforeState)} after=${JSON.stringify(afterState)}`);
    });

    // ================================================================================
    await section("D", "research_get exposes the queue, in order", async () => {
      const res = await callTool(mcp.client, "research_get", { companionId: ID });
      console.log("research_get ->", JSON.stringify(res));
      check("D.1: queue_count === 2", res?.queue_count === 2, JSON.stringify(res));
      check(
        "D.2: queue array has 2 entries in order [techA, techB]",
        Array.isArray(res?.queue) && res.queue.length === 2 && res.queue[0]?.name === techA && res.queue[1]?.name === techB,
        JSON.stringify(res?.queue)
      );
      check("D.3: current still reports techA", res?.current?.name === techA, JSON.stringify(res?.current));
    });

    // ================================================================================
    await section("E", "unchanged guard: an unknown technology name refuses 'Not found'", async () => {
      const res = await callTool(mcp.client, "research_set", { companionId: ID, technology: "definitely-not-a-real-technology-xyz" });
      console.log("research_set(bogus name) ->", JSON.stringify(res));
      check("E.1: exact error 'Not found'", res?.error === "Not found", JSON.stringify(res));

      const truth = await queueState(rcon);
      check("E.2 DECISIVE: queue is unaffected by the refused call", truth.queue.length === 2 && truth.queue[0] === techA && truth.queue[1] === techB, JSON.stringify(truth));
    });

    // ================================================================================
    await section("F", "unchanged guard: an already-researched technology refuses 'Already done'", async () => {
      await setResearched(rcon, techC, true);
      markedResearched = techC;
      const marked = await lua(rcon, `rcon.print(helpers.table_to_json({researched = game.players[1].force.technologies["${techC}"].researched}))`);
      check("F setup: techC genuinely marked researched (side channel)", marked.researched === true, JSON.stringify(marked));
      if (marked.researched !== true) return;

      const res = await callTool(mcp.client, "research_set", { companionId: ID, technology: techC });
      console.log(`research_set(${techC}, already researched) ->`, JSON.stringify(res));
      check("F.1: exact error 'Already done'", res?.error === "Already done", JSON.stringify(res));

      const truth = await queueState(rcon);
      check("F.2 DECISIVE: queue is unaffected by the refused call", truth.queue.length === 2 && truth.queue[0] === techA && truth.queue[1] === techB, JSON.stringify(truth));
    });
  } finally {
    console.log("\n--- Teardown ---");
    try {
      await resetQueue(rcon);
      const finalState = await queueState(rcon);
      check("teardown: research queue cleared", finalState.queue.length === 0, JSON.stringify(finalState));
      if (markedResearched) {
        await setResearched(rcon, markedResearched, false);
        console.log(`Teardown: reset ${markedResearched}.researched back to false (unlock effects, if any, are NOT reverted - see setResearched note)`);
      }
      await callTool(mcp.client, "companion_disappear", { companionId: ID }).catch(() => {});
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
