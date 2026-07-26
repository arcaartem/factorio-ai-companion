// Live smoke test for commit e9c7190 (fix: repair MCP server skill tracking
// and stop double-draining chat). Covers:
//   2a - move_to's idempotent re-poll branch
//   2b - the skill exit-handler pid guard (a killed skill's async exit must
//        not clobber the replacement skill's tracking entry)
//   2c - exactly one process drains the chat queue (this server does not poll)
//
// Run directly against a live Factorio game + MCP server:
//   bun run scripts/smoke/t024-skill-lifecycle.ts
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { connectMCP, connectRCON, callTool, callToolRaw, check, summary } from "./lib";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const mcp = await connectMCP();
  const rcon = await connectRCON();

  try {
    console.log("=== Setup: spawn companion 1 ===");
    const spawnRes = await callTool(mcp.client, "companion_spawn", { companionId: 1 });
    console.log("companion_spawn ->", JSON.stringify(spawnRes));

    // -----------------------------------------------------------
    // 2a - repeated move_to is idempotent
    // -----------------------------------------------------------
    console.log("\n=== 2a: move_to idempotency ===");
    const posRes = await callTool(mcp.client, "companion_position", { companionId: 1 });
    console.log("companion_position ->", JSON.stringify(posRes));
    const tx = posRes.position.x + 25; // >20 tiles away, safely past ARRIVE_DIST (1.5)
    const ty = posRes.position.y;

    const move1 = await callTool(mcp.client, "move_to", { companionId: 1, x: tx, y: ty });
    console.log("1st move_to ->", JSON.stringify(move1));
    check("2a: 1st move_to has started === true", move1.started === true, JSON.stringify(move1));
    check("2a: 1st move_to has active === true", move1.active === true, JSON.stringify(move1));
    check(
      "2a: 1st move_to has status 'requesting' or 'walking'",
      move1.status === "requesting" || move1.status === "walking",
      JSON.stringify(move1)
    );

    await sleep(400);

    const move2 = await callTool(mcp.client, "move_to", { companionId: 1, x: tx, y: ty });
    console.log("2nd (identical) move_to ->", JSON.stringify(move2));
    check(
      "2a TIMING-INDEPENDENT: 2nd identical move_to has NO 'started' key (idempotent branch returned early)",
      !("started" in move2),
      JSON.stringify(move2)
    );
    check("2a: 2nd move_to status === 'walking'", move2.status === "walking", JSON.stringify(move2));
    check(
      "2a: 2nd move_to distance_remaining is strictly less than the 1st call's",
      typeof move1.distance_remaining === "number" &&
        typeof move2.distance_remaining === "number" &&
        move2.distance_remaining < move1.distance_remaining,
      `move1.distance_remaining=${move1.distance_remaining} move2.distance_remaining=${move2.distance_remaining}`
    );

    await callTool(mcp.client, "move_stop", { companionId: 1 });

    // -----------------------------------------------------------
    // 2b - skill exit-handler pid guard
    // -----------------------------------------------------------
    console.log("\n=== 2b: skill exit-handler pid guard ===");
    const startA = await callToolRaw(mcp.client, "resource_mine_until", { companionId: 1, resource: "iron-ore" });
    console.log("resource_mine_until (A) ->", startA);

    const statusA = await callTool(mcp.client, "companion_status", { companionId: 1 });
    console.log("companion_status after start A ->", JSON.stringify(statusA));
    check("2b: skill A is running", statusA.skill?.running === true, JSON.stringify(statusA));
    const pidA = statusA.skill?.pid;

    const stopMsg = await callToolRaw(mcp.client, "companion_stop", { companionId: 1 });
    console.log("companion_stop ->", stopMsg);

    const startB = await callToolRaw(mcp.client, "resource_mine_until", { companionId: 1, resource: "iron-ore" });
    console.log("resource_mine_until (B) ->", startB);

    const statusBImmediate = await callTool(mcp.client, "companion_status", { companionId: 1 });
    console.log("companion_status after start B ->", JSON.stringify(statusBImmediate));
    const pidB = statusBImmediate.skill?.pid;
    check("2b: skill B has a different pid than A", pidB !== undefined && pidB !== pidA, `pidA=${pidA} pidB=${pidB}`);

    await sleep(500); // let A's async 'exit' event fire

    const statusAfterExit = await callTool(mcp.client, "companion_status", { companionId: 1 });
    console.log("companion_status 500ms later (after A's exit fires) ->", JSON.stringify(statusAfterExit));
    check(
      "2b DECISIVE: companion_status.skill is still {running:true, pid:B} - A's exit did not clobber B's entry",
      statusAfterExit.skill?.running === true && statusAfterExit.skill?.pid === pidB,
      JSON.stringify(statusAfterExit)
    );

    const startC = await callToolRaw(mcp.client, "resource_mine_until", { companionId: 1, resource: "iron-ore" });
    console.log("resource_mine_until (C, should be rejected) ->", startC);
    check(
      "2b: a 3rd resource_mine_until is rejected as already running",
      startC.toLowerCase().includes("already running"),
      startC
    );

    await callToolRaw(mcp.client, "companion_stop", { companionId: 1 });

    // -----------------------------------------------------------
    // 2c - exactly one process drains the chat queue
    // -----------------------------------------------------------
    console.log("\n=== 2c: exactly one process drains the chat queue ===");
    let notificationCount = 0;
    mcp.client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      notificationCount++;
      console.log("Received notifications/message:", JSON.stringify(notification));
    });

    // No-id form only: "/fac <id> <msg>" nil-derefs player.name for an RCON invocation.
    const injectMsg = "hello-smoke-test";
    await rcon.send(`/fac ${injectMsg}`);
    console.log(`Injected chat message via side channel: /fac ${injectMsg}`);

    console.log("Idling 3.2s without calling any tool (the deleted poller was a 3s setInterval)...");
    await sleep(3200);

    const chatMessages = await callTool(mcp.client, "chat_get", {});
    console.log("chat_get ->", JSON.stringify(chatMessages));
    const found = Array.isArray(chatMessages) && chatMessages.some((m: any) => m.message === injectMsg);
    check(
      "2c DECISIVE: chat_get still returns the injected message (unfixed: the server's poller stole it, chat_get -> {})",
      found,
      JSON.stringify(chatMessages)
    );
    check("2c: zero notifications/message were received", notificationCount === 0, `notificationCount=${notificationCount}`);
  } finally {
    console.log("\n--- Cleanup ---");
    try {
      await callToolRaw(mcp.client, "companion_stop", { companionId: 1 });
    } catch (e) {
      console.log("Cleanup companion_stop failed (reporting, not hiding):", e);
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
