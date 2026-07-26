// Live smoke test for commit 1482f09 (mod 0.13.5): "never destroy items before
// the companion accepts them" - building_empty (partial shortfall) and
// building_remove (full inventory) must not destroy items/entities when the
// companion's inventory can't hold what would otherwise be extracted/removed.
//
// Run directly against a live Factorio game + MCP server:
//   bun run scripts/smoke/t019-building-item-loss.ts
import { connectMCP, connectRCON, callTool, callToolRaw, check, summary, silent } from "./lib";

const JUNK_ITEM = "stone"; // distinct from iron-plate, the item under test

function findCompanionLua(x: number, y: number): string {
  return `
    local __player = game.players[1]
    local __target
    for _, e in ipairs(__player.surface.find_entities_filtered{name="character", position={x=${x}, y=${y}}, radius=3}) do
      if e.valid and e ~= __player.character then __target = e; break end
    end
    if not __target then rcon.print(helpers.table_to_json({error = "companion not found"})); return end
  `;
}

async function main() {
  const mcp = await connectMCP();
  const rcon = await connectRCON();

  let px = 0;
  let py = 0;
  let bonusBefore = 0;

  try {
    console.log("=== Setup: spawn companion 1 ===");
    const spawnRes = await callTool(mcp.client, "companion_spawn", { companionId: 1 });
    console.log("companion_spawn ->", JSON.stringify(spawnRes));

    const posRes = await callTool(mcp.client, "companion_position", { companionId: 1 });
    console.log("companion_position ->", JSON.stringify(posRes));
    px = posRes.position.x;
    py = posRes.position.y;

    console.log("\n=== Probe: is character_inventory_slots_bonus writable? ===");
    const probeRaw = await silent(
      rcon,
      findCompanionLua(px, py) +
        `
        local before = __target.character_inventory_slots_bonus
        local ok = pcall(function() __target.character_inventory_slots_bonus = -70 end)
        local inv = __target.get_inventory(defines.inventory.character_main)
        rcon.print(helpers.table_to_json({before = before, write_ok = ok, slots = #inv}))
      `
    );
    const probe = JSON.parse(probeRaw);
    console.log("Probe result ->", JSON.stringify(probe));
    bonusBefore = probe.before ?? 0;
    const totalSlots: number = probe.slots;
    if (probe.write_ok === true && totalSlots < 80) {
      console.log(
        `character_inventory_slots_bonus IS writable on a controllerless companion (slots shrank to ${totalSlots}). ` +
          `Using that instead of an 80-slot junk fill.`
      );
    } else {
      console.log(
        `character_inventory_slots_bonus did NOT shrink the inventory (write_ok=${probe.write_ok}, slots=${totalSlots}). ` +
          `Falling back to a full junk fill of the reported ${totalSlots} slots.`
      );
    }

    // ---------------------------------------------------------------
    // 1a - building_empty partial shortfall
    // ---------------------------------------------------------------
    console.log("\n=== 1a setup: fill inventory leaving one slot with 95/100 iron-plate ===");
    const fill1aRaw = await silent(
      rcon,
      findCompanionLua(px, py) +
        `
        local inv = __target.get_inventory(defines.inventory.character_main)
        inv.clear()
        local slots = #inv
        local stack = prototypes.item["${JUNK_ITEM}"].stack_size
        if slots > 1 then inv.insert{name="${JUNK_ITEM}", count = (slots - 1) * stack} end
        inv.insert{name="iron-plate", count = 95}
        rcon.print(helpers.table_to_json({
          slots = slots,
          empty = inv.count_empty_stacks(),
          iron = inv.get_item_count("iron-plate"),
          junk = inv.get_item_count("${JUNK_ITEM}")
        }))
      `
    );
    const fill1a = JSON.parse(fill1aRaw);
    console.log("Fill result ->", JSON.stringify(fill1a));
    check("1a setup: inventory has zero empty stacks", fill1a.empty === 0, JSON.stringify(fill1a));
    check("1a setup: exactly 95 iron-plate present (5 short of a full stack)", fill1a.iron === 95, JSON.stringify(fill1a));

    console.log("\n=== 1a setup: scan for pre-existing containers near the companion ===");
    const scanRaw = await silent(
      rcon,
      `
        local __player = game.players[1]
        local nearby = __player.surface.find_entities_filtered{position = {x=${px}, y=${py}}, radius = 6, type = {"container", "logistic-container"}}
        rcon.print(helpers.table_to_json({count = #nearby}))
      `
    );
    const scan = JSON.parse(scanRaw);
    console.log("Container scan ->", JSON.stringify(scan));
    if (scan.count > 0) {
      console.log(
        `WARNING: ${scan.count} container(s) already within radius 6 of the companion. ` +
          `building_empty scans the same radius and could pick these up too, which would corrupt the extracted count.`
      );
    }

    console.log("\n=== 1a setup: place a wooden-chest with 50 iron-plate ===");
    const chestX = px + 3;
    const chestY = py;
    const placeRaw = await silent(
      rcon,
      `
        local __player = game.players[1]
        local e = __player.surface.create_entity{name="wooden-chest", position={x=${chestX}, y=${chestY}}, force=__player.force}
        if not e then rcon.print(helpers.table_to_json({error = "create failed"})); return end
        e.insert{name="iron-plate", count=50}
        rcon.print(helpers.table_to_json({created = true, x = e.position.x, y = e.position.y, iron = e.get_inventory(defines.inventory.chest).get_item_count("iron-plate")}))
      `
    );
    const place = JSON.parse(placeRaw);
    console.log("Chest placed ->", JSON.stringify(place));
    check("1a setup: chest created holding 50 iron-plate", place.created === true && place.iron === 50, JSON.stringify(place));

    console.log("\n=== 1a: building_empty(iron-plate, count=50) ===");
    const emptyRes = await callTool(mcp.client, "building_empty", { companionId: 1, itemName: "iron-plate", count: 50 });
    console.log("building_empty response ->", JSON.stringify(emptyRes));
    check("1a: response.full === true", emptyRes.full === true, JSON.stringify(emptyRes));
    check("1a: response.extracted === 5", emptyRes.extracted === 5, JSON.stringify(emptyRes));

    console.log("\n=== 1a DECISIVE: read chest contents back over the side channel ===");
    const readChestRaw = await silent(
      rcon,
      `
        local __player = game.players[1]
        local es = __player.surface.find_entities_filtered{name="wooden-chest", position={x=${chestX}, y=${chestY}}, radius=1}
        if #es == 0 then rcon.print(helpers.table_to_json({error = "chest gone"})); return end
        rcon.print(helpers.table_to_json({iron = es[1].get_inventory(defines.inventory.chest).get_item_count("iron-plate")}))
      `
    );
    const readChest = JSON.parse(readChestRaw);
    console.log("Chest contents after building_empty ->", JSON.stringify(readChest));
    check(
      "1a DECISIVE: chest retains 45 iron-plate (50 - 5 accepted); the 5-plate shortfall was NOT destroyed",
      readChest.iron === 45,
      JSON.stringify(readChest)
    );

    await silent(
      rcon,
      `
        local __player = game.players[1]
        for _, e in ipairs(__player.surface.find_entities_filtered{name="wooden-chest", position={x=${chestX}, y=${chestY}}, radius=1}) do e.destroy() end
        rcon.print("OK")
      `
    );

    // ---------------------------------------------------------------
    // 1b - building_remove with a full inventory
    // ---------------------------------------------------------------
    console.log("\n=== 1b setup: refill companion inventory to zero empty slots ===");
    const fill1bRaw = await silent(
      rcon,
      findCompanionLua(px, py) +
        `
        local inv = __target.get_inventory(defines.inventory.character_main)
        inv.clear()
        local slots = #inv
        local stack = prototypes.item["${JUNK_ITEM}"].stack_size
        inv.insert{name="${JUNK_ITEM}", count = slots * stack}
        rcon.print(helpers.table_to_json({slots = slots, empty = inv.count_empty_stacks()}))
      `
    );
    const fill1b = JSON.parse(fill1bRaw);
    console.log("Fill result ->", JSON.stringify(fill1b));
    check("1b setup: inventory has zero empty stacks", fill1b.empty === 0, JSON.stringify(fill1b));

    console.log("\n=== 1b setup: place a fresh wooden-chest ===");
    const chest2X = px;
    const chest2Y = py + 3;
    const place2Raw = await silent(
      rcon,
      `
        local __player = game.players[1]
        local e = __player.surface.create_entity{name="wooden-chest", position={x=${chest2X}, y=${chest2Y}}, force=__player.force}
        if not e then rcon.print(helpers.table_to_json({error = "create failed"})); return end
        rcon.print(helpers.table_to_json({created = true, x = e.position.x, y = e.position.y}))
      `
    );
    const place2 = JSON.parse(place2Raw);
    console.log("Chest 2 placed ->", JSON.stringify(place2));
    check("1b setup: fresh chest created", place2.created === true, JSON.stringify(place2));

    console.log("\n=== 1b: building_remove(wooden-chest) with a full inventory ===");
    const removeRawText = await callToolRaw(mcp.client, "building_remove", {
      companionId: 1,
      entityName: "wooden-chest",
      x: chest2X,
      y: chest2Y,
    });
    console.log("building_remove raw response ->", removeRawText);
    let removeParsed: any = null;
    try {
      removeParsed = JSON.parse(removeRawText);
    } catch {
      /* left null, reported below */
    }
    check(
      "1b: response is {error:'Inventory full', full:true} (refused, not destroyed)",
      removeParsed !== null && removeParsed.error === "Inventory full" && removeParsed.full === true,
      removeRawText
    );

    console.log("\n=== 1b DECISIVE: building_info confirms the chest still exists ===");
    const infoRes = await callTool(mcp.client, "building_info", {
      companionId: 1,
      entityName: "wooden-chest",
      x: chest2X,
      y: chest2Y,
    });
    console.log("building_info response ->", JSON.stringify(infoRes));
    check(
      "1b DECISIVE: chest STILL EXISTS after the refused removal (unfixed would report {error:'Not found'})",
      infoRes.entity !== undefined && infoRes.entity.name === "wooden-chest",
      JSON.stringify(infoRes)
    );
  } finally {
    console.log("\n--- Cleanup ---");
    try {
      const cleanupRaw = await silent(
        rcon,
        `
          local __player = game.players[1]
          local removed = 0
          for _, e in ipairs(__player.surface.find_entities_filtered{name="wooden-chest", position={x=${px}, y=${py}}, radius=8}) do
            e.destroy(); removed = removed + 1
          end
          local __target
          for _, e in ipairs(__player.surface.find_entities_filtered{name="character", position={x=${px}, y=${py}}, radius=3}) do
            if e.valid and e ~= __player.character then __target = e; break end
          end
          if __target then
            __target.get_inventory(defines.inventory.character_main).clear()
            __target.character_inventory_slots_bonus = ${bonusBefore}
          end
          rcon.print(helpers.table_to_json({chests_removed = removed, companion_found = __target ~= nil}))
        `
      );
      console.log("Cleanup ->", cleanupRaw);
    } catch (e) {
      console.log("Cleanup failed (reporting, not hiding):", e);
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
