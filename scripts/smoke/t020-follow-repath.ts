// Live smoke test for commit 9d8880c (mod 0.13.6): "let follow queues re-path
// out of no_path and stuck". queues.lua:259-275 - a FOLLOW queue latched in
// "stuck"/"no_path" now retries request_path once FOLLOW_REPATH_TICKS have
// passed since the last attempt, instead of freezing forever. Non-follow
// queues stay terminal by design (unaffected here).
//
// Queue state is NOT observable through any tool - there is no fac_move_status
// command, and polling with move_to/move_follow would itself restart the
// pathfind. companion_position (positional inference only) is therefore the
// only valid signal used below; no movement tool is called between removing
// the walls and observing spontaneous recovery.
//
// IMPORTANT setup hazard learned the hard way in this session: the companion
// walks at roughly 8-9 tiles/sec. A slow baseline-sampling loop (originally
// 4 x 1s) let it close a 30-tile gap and reach ARRIVE_DIST (1.5) BEFORE the
// wall ring went up. Once "arrived", the walking queue's early-return branch
// (queues.lua's dist_to_target < ARRIVE_DIST check, evaluated before the
// no_path/stuck repath logic) latches every tick regardless of walls - so
// removing the walls does nothing, which is correct behaviour for "arrived",
// NOT evidence about this fix. To avoid that false negative: baseline
// sampling is short (2 x 500ms), the ring-build reads the companion's LIVE
// position and computes live distance-to-player in the SAME atomic Lua call
// used to place the ring, and the whole attempt is retried with a bigger
// teleport gap if that distance isn't comfortably above ARRIVE_DIST when the
// ring closes.
//
// Run directly against a live Factorio game + MCP server:
//   bun run scripts/smoke/t020-follow-repath.ts
import { connectMCP, connectRCON, callTool, check, summary, silent, EPS } from "./lib";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors queues.lua's constants (queues.lua:7-20) so poll windows carry real margin.
const STUCK_MS = 3000; // STUCK_TICKS=180 @ 60 UPS (~3s)
const ARRIVE_DIST = 1.5;
const WALL_MARGIN_DIST = 5; // must clear this by a wide margin over ARRIVE_DIST when the ring closes
const TELEPORT_OFFSETS = [30, 60, 100, 150]; // retry with a bigger gap if a faster-than-expected close beats the ring
const BASELINE_SAMPLES = 2;
const BASELINE_INTERVAL_MS = 500;
const FREEZE_POLL_BUDGET_MS = 15000;
const RECOVERY_POLL_BUDGET_MS = 20000;
const POLL_INTERVAL_MS = 1200;

interface Sample {
  t: number;
  x: number;
  y: number;
  dist?: number;
}

function findCompanionLua(x: number, y: number, radius = 6): string {
  return `
    local __player = game.players[1]
    local __target
    for _, e in ipairs(__player.surface.find_entities_filtered{name="character", position={x=${x}, y=${y}}, radius=${radius}}) do
      if e.valid and e ~= __player.character then __target = e; break end
    end
    if not __target then rcon.print(helpers.table_to_json({error = "companion not found"})); return end
  `;
}

async function removeWalls(
  rcon: { send: (cmd: string) => Promise<string> },
  positions: Array<{ x: number; y: number }>
): Promise<number> {
  if (positions.length === 0) return 0;
  const removeLua = positions
    .map(
      (w) =>
        `for _, e in ipairs(game.players[1].surface.find_entities_filtered{name="stone-wall", position={x=${w.x}, y=${w.y}}, radius=0.6}) do e.destroy(); removed = removed + 1 end`
    )
    .join("\n");
  const raw = await silent(rcon, `local removed = 0\n${removeLua}\nrcon.print(helpers.table_to_json({removed = removed}))`);
  return JSON.parse(raw).removed;
}

async function main() {
  const mcp = await connectMCP();
  const rcon = await connectRCON();

  let wallPositions: Array<{ x: number; y: number }> = [];
  let wallCenter: { x: number; y: number } | null = null;
  let playerName = "";

  try {
    console.log("=== Setup: spawn companion 1 ===");
    const spawnRes = await callTool(mcp.client, "companion_spawn", { companionId: 1 });
    console.log("companion_spawn ->", JSON.stringify(spawnRes));

    const initialPos = await callTool(mcp.client, "companion_position", { companionId: 1 });
    console.log("companion_position (initial) ->", JSON.stringify(initialPos));

    const nameRaw = await silent(rcon, `rcon.print(helpers.table_to_json({name = game.players[1].name}))`);
    playerName = JSON.parse(nameRaw).name;
    console.log("Player name ->", playerName);

    // -----------------------------------------------------------
    // Retry loop: teleport further out each time a wall-build attempt finds
    // the companion already too close to the player when the ring closes.
    // -----------------------------------------------------------
    let wall: any = null;
    let baseline: Sample[] = [];
    let lastCompanionPos = { x: initialPos.position.x, y: initialPos.position.y };

    for (const offset of TELEPORT_OFFSETS) {
      console.log(`\n=== Attempt: teleport companion ${offset} tiles from the player ===`);
      const teleportRaw = await silent(
        rcon,
        findCompanionLua(lastCompanionPos.x, lastCompanionPos.y, 12) +
          `
          local __player = game.players[1]
          local raw_target = {x = __player.position.x + ${offset}, y = __player.position.y}
          local dest = __target.surface.find_non_colliding_position("character", raw_target, 15, 0.5)
          if not dest then rcon.print(helpers.table_to_json({error = "no clear spot found near raw target"})); return end
          local ok = __target.teleport(dest)
          rcon.print(helpers.table_to_json({teleported = ok, x = __target.position.x, y = __target.position.y}))
        `
      );
      const teleport = JSON.parse(teleportRaw);
      console.log("Teleport result ->", JSON.stringify(teleport));
      check(
        `attempt (offset ${offset}): companion teleported to a clear, walkable spot`,
        teleport.teleported === true,
        JSON.stringify(teleport)
      );
      if (teleport.teleported !== true) continue;
      lastCompanionPos = { x: teleport.x, y: teleport.y };

      const followRes = await callTool(mcp.client, "move_follow", { companionId: 1, playerName });
      console.log("move_follow ->", JSON.stringify(followRes));

      baseline = [];
      for (let i = 0; i < BASELINE_SAMPLES; i++) {
        const pos = await callTool(mcp.client, "companion_position", { companionId: 1 });
        const playerEntry = (pos.players || []).find((p: any) => p.name === playerName);
        const sample: Sample = { t: Date.now(), x: pos.position.x, y: pos.position.y, dist: playerEntry?.distance };
        baseline.push(sample);
        console.log("baseline sample ->", JSON.stringify(sample));
        if (i < BASELINE_SAMPLES - 1) await sleep(BASELINE_INTERVAL_MS);
      }
      const lastBaseline = baseline[baseline.length - 1]!;
      lastCompanionPos = { x: lastBaseline.x, y: lastBaseline.y };

      console.log("=== Wall the companion in (atomic find + ring build + live distance check) ===");
      const wallRaw = await silent(
        rcon,
        findCompanionLua(lastCompanionPos.x, lastCompanionPos.y, 12) +
          `
          local __player = game.players[1]
          local cx = math.floor(__target.position.x) + 0.5
          local cy = math.floor(__target.position.y) + 0.5
          local created = {}
          for dx = -1, 1 do
            for dy = -1, 1 do
              if not (dx == 0 and dy == 0) then
                local pos = {x = cx + dx, y = cy + dy}
                local e = __target.surface.create_entity{name="stone-wall", position=pos, force=__player.force}
                if e then created[#created + 1] = {x = e.position.x, y = e.position.y} end
              end
            end
          end
          local dx2 = __target.position.x - __player.position.x
          local dy2 = __target.position.y - __player.position.y
          local dist_to_player = (dx2 * dx2 + dy2 * dy2) ^ 0.5
          rcon.print(helpers.table_to_json({
            center = {x = cx, y = cy},
            companion_pos = {x = __target.position.x, y = __target.position.y},
            created = created,
            count = #created,
            dist_to_player = dist_to_player
          }))
        `
      );
      wall = JSON.parse(wallRaw);
      console.log("Wall build attempt ->", JSON.stringify(wall));

      if (wall.count === 8 && wall.dist_to_player > WALL_MARGIN_DIST) {
        console.log(
          `Attempt succeeded: dist_to_player=${wall.dist_to_player.toFixed(2)} > margin ${WALL_MARGIN_DIST} ` +
            `(comfortably above ARRIVE_DIST=${ARRIVE_DIST}) when the ring closed.`
        );
        wallPositions = wall.created;
        wallCenter = wall.center;
        break;
      }

      console.log(
        `Attempt failed: dist_to_player=${wall.dist_to_player?.toFixed?.(2)} count=${wall.count} - ` +
          `either it already closed to near ARRIVE_DIST, or the ring didn't fully build. Cleaning up and retrying with a bigger gap.`
      );
      const removed = await removeWalls(rcon, wall.created || []);
      console.log(`Removed ${removed} stray wall(s) from the failed attempt.`);
      wall = null;
    }

    check(
      "wall setup: companion was walled in while still comfortably far (> margin) from the player",
      wall !== null,
      wall === null ? "all teleport-distance retries closed to near ARRIVE_DIST before the ring could go up" : JSON.stringify(wall)
    );

    if (wall === null) {
      console.log(
        "Could not construct a valid no_path/stuck scenario within the retry budget - skipping the freeze/recovery " +
          "assertions below since there is nothing meaningful to test against. This is an ENVIRONMENT/harness-timing " +
          "issue, not evidence about the fix."
      );
    } else {
      // -----------------------------------------------------------
      // Poll companion_position (the only valid signal) until frozen.
      // -----------------------------------------------------------
      console.log("\n=== Poll companion_position until FROZEN (expect no_path/stuck latch) ===");
      const freezeSamples: Sample[] = [];
      const freezeStart = Date.now();
      let frozenAt: Sample | null = null;
      while (Date.now() - freezeStart < FREEZE_POLL_BUDGET_MS && !frozenAt) {
        const pos = await callTool(mcp.client, "companion_position", { companionId: 1 });
        const playerEntry = (pos.players || []).find((p: any) => p.name === playerName);
        const sample: Sample = { t: Date.now(), x: pos.position.x, y: pos.position.y, dist: playerEntry?.distance };
        freezeSamples.push(sample);
        console.log("freeze-poll sample ->", JSON.stringify(sample));

        if (freezeSamples.length >= 4) {
          const lastFour = freezeSamples.slice(-4);
          const firstOfFour = lastFour[0]!;
          const lastOfFour = lastFour[lastFour.length - 1]!;
          const allSame = lastFour.every(
            (s) => Math.abs(s.x - firstOfFour.x) < EPS && Math.abs(s.y - firstOfFour.y) < EPS
          );
          const span = lastOfFour.t - firstOfFour.t;
          if (allSame && span >= STUCK_MS) {
            frozenAt = lastOfFour;
          }
        }
        if (!frozenAt) await sleep(POLL_INTERVAL_MS);
      }
      console.log("Frozen position ->", JSON.stringify(frozenAt));
      check(
        "FROZEN: companion position latched (no_path/stuck) after being walled in, for >= STUCK_TICKS",
        frozenAt !== null,
        JSON.stringify(freezeSamples)
      );
      check(
        "FROZEN sanity: frozen distance-to-player is still above ARRIVE_DIST (this is a no_path/stuck latch, not 'arrived')",
        frozenAt !== null && frozenAt.dist !== undefined && frozenAt.dist > ARRIVE_DIST,
        JSON.stringify(frozenAt)
      );

      // -----------------------------------------------------------
      // Remove every wall.
      // -----------------------------------------------------------
      console.log("\n=== Remove all walls ===");
      const removed = await removeWalls(rcon, wallPositions);
      console.log(`Removed ${removed} wall(s).`);
      check("cleanup: all created walls were destroyed", removed === wallPositions.length, `removed=${removed} expected=${wallPositions.length}`);

      const verifyClearRaw = await silent(
        rcon,
        `
          local __player = game.players[1]
          local remaining = __player.surface.find_entities_filtered{name="stone-wall", position={x=${wallCenter?.x}, y=${wallCenter?.y}}, radius=3}
          rcon.print(helpers.table_to_json({remaining = #remaining}))
        `
      );
      const verifyClear = JSON.parse(verifyClearRaw);
      console.log("Post-removal wall scan ->", JSON.stringify(verifyClear));
      check("cleanup: zero stone-walls remain around the ring site", verifyClear.remaining === 0, JSON.stringify(verifyClear));

      // -----------------------------------------------------------
      // THE DECISIVE ASSERTION: spontaneous recovery, no move tool re-issued.
      // -----------------------------------------------------------
      console.log("\n=== Poll for spontaneous recovery (NO move tool called between here and above) ===");
      const recoverySamples: Sample[] = [];
      const recoveryStart = Date.now();
      let recovered = false;
      let recoveredSample: Sample | null = null;
      while (Date.now() - recoveryStart < RECOVERY_POLL_BUDGET_MS && !recovered) {
        const pos = await callTool(mcp.client, "companion_position", { companionId: 1 });
        const playerEntry = (pos.players || []).find((p: any) => p.name === playerName);
        const sample: Sample = { t: Date.now(), x: pos.position.x, y: pos.position.y, dist: playerEntry?.distance };
        recoverySamples.push(sample);
        console.log("recovery-poll sample ->", JSON.stringify(sample));

        const movedFromFrozen =
          frozenAt !== null && (Math.abs(sample.x - frozenAt.x) > EPS || Math.abs(sample.y - frozenAt.y) > EPS);
        const distDropped =
          frozenAt?.dist !== undefined && sample.dist !== undefined && sample.dist < frozenAt.dist;
        if (movedFromFrozen && distDropped) {
          recovered = true;
          recoveredSample = sample;
        }
        if (!recovered) await sleep(POLL_INTERVAL_MS);
      }
      console.log("Recovered sample ->", JSON.stringify(recoveredSample));
      check(
        "DECISIVE: companion resumed moving on its own after wall removal (position changed AND distance-to-player decreased), no move tool re-issued",
        recovered,
        JSON.stringify(recoverySamples)
      );
    }
  } finally {
    console.log("\n--- Cleanup ---");
    try {
      await callTool(mcp.client, "companion_stop", { companionId: 1 });
    } catch (e) {
      console.log("Cleanup companion_stop failed (reporting, not hiding):", e);
    }
    try {
      const cx = wallCenter?.x ?? 0;
      const cy = wallCenter?.y ?? 0;
      const finalScanRaw = await silent(
        rcon,
        `
          local __player = game.players[1]
          local remaining = __player.surface.find_entities_filtered{name="stone-wall", position={x=${cx}, y=${cy}}, radius=8}
          local destroyed = 0
          for _, e in ipairs(remaining) do e.destroy(); destroyed = destroyed + 1 end
          rcon.print(helpers.table_to_json({destroyed_in_final_sweep = destroyed}))
        `
      );
      console.log("Final wall sweep ->", finalScanRaw);
    } catch (e) {
      console.log("Final wall sweep failed (reporting, not hiding):", e);
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
