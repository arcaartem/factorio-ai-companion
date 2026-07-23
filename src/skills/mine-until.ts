#!/usr/bin/env bun
import { RCONClient } from "../rcon/client";
import { getRCONConfig } from "../config";
import { connectWithRetry, sleep } from "../utils/connection";

const POLL_INTERVAL = 500;
const MINING_TIMEOUT = 30000;
const WALKING_TIMEOUT = 60000;

const companionId = parseInt(process.argv[2]);
const resourceType = process.argv[3];
const parsedTargetAmount = parseInt(process.argv[4]);
const targetAmount = process.argv[4] === undefined || isNaN(parsedTargetAmount) ? 50 : parsedTargetAmount;

if (!companionId || !resourceType) {
  console.error("Usage: bun run src/skills/mine-until.ts <companionId> <resource> <targetAmount>");
  console.error("Example: bun run src/skills/mine-until.ts 1 iron-ore 50");
  process.exit(1);
}

const normalize: Record<string, string> = {
  iron: "iron-ore",
  copper: "copper-ore",
  coal: "coal",
  stone: "stone",
  uranium: "uranium-ore"
};
const resource = normalize[resourceType] || resourceType;

const client = new RCONClient(getRCONConfig());

async function say(msg: string): Promise<void> {
  await client.sendCommand(`/fac_chat_say ${companionId} "${msg}"`);
}

async function exec(cmd: string): Promise<any> {
  const response = await client.sendCommand(cmd);
  if (!response.success || !response.data) return null;
  try {
    return JSON.parse(response.data);
  } catch {
    return response.data;
  }
}

async function getPosition(): Promise<{x: number, y: number} | null> {
  const data = await exec(`/fac_companion_position ${companionId}`);
  return data?.position || null;
}

async function getInventoryCount(itemName: string): Promise<number> {
  const data = await exec(`/fac_companion_inventory ${companionId}`);
  if (!data?.items) return 0;

  // items can be:
  // - Empty object {} when empty
  // - Array [{name, count, quality}, ...] when items exist
  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      if (item.name === itemName) return item.count || 0;
    }
  }
  return 0;
}

async function findNearest(): Promise<{position: {x: number, y: number}, distance: number, amount: number} | null> {
  const data = await exec(`/fac_resource_nearest ${companionId} ${resource}`);
  if (data?.error || !data?.position) return null;
  return {
    position: data.position,
    distance: data.distance,
    amount: data.amount
  };
}

async function walkTo(x: number, y: number): Promise<boolean> {
  await exec(`/fac_move_to ${companionId} ${x} ${y}`);

  const startTime = Date.now();
  while (Date.now() - startTime < WALKING_TIMEOUT) {
    const pos = await getPosition();
    if (!pos) break;

    const dist = Math.sqrt(Math.pow(pos.x - x, 2) + Math.pow(pos.y - y, 2));
    if (dist < 2) return true; // Arrived

    await sleep(POLL_INTERVAL);
  }
  return false;
}

async function startMining(x: number, y: number, count: number): Promise<boolean> {
  // Pass resource name to filter only the specific resource type
  const result = await exec(`/fac_resource_mine ${companionId} ${x} ${y} ${count} ${resource}`);
  return result?.mining === true;
}

async function waitForMiningComplete(): Promise<number> {
  const startTime = Date.now();
  let lastStatus: any = null;

  while (Date.now() - startTime < MINING_TIMEOUT) {
    const status = await exec(`/fac_resource_mine_status ${companionId}`);
    lastStatus = status?.status;

    if (!status?.status?.active) {
      // Mining finished
      return lastStatus?.harvested || 0;
    }

    await sleep(POLL_INTERVAL);
  }

  // Timeout - stop mining
  await exec(`/fac_resource_mine_stop ${companionId}`);
  return lastStatus?.harvested || 0;
}


async function main(): Promise<void> {
  let totalMined = 0;

  try {
    await client.connect();
    console.log(`[Companion #${companionId}] Starting mine-until: ${resource} x${targetAmount}`);
    await say(`Starting to mine ${resource} until I have ${targetAmount}...`);

    let attempts = 0;
    const maxAttempts = 50; // Prevent infinite loops
    const visitedSpots = new Set<string>(); // Track visited spots to avoid loops
    let consecutiveZeroMines = 0; // Track when we're stuck

    while (totalMined < targetAmount && attempts < maxAttempts) {
      attempts++;

      // Check current inventory
      const currentCount = await getInventoryCount(resource);
      if (currentCount >= targetAmount) {
        await say(`I already have ${currentCount} ${resource}!`);
        break;
      }

      // Find nearest resource, excluding visited spots
      let nearest = await findNearest();
      let searchAttempts = 0;
      while (nearest && visitedSpots.has(`${nearest.position.x},${nearest.position.y}`) && searchAttempts < 10) {
        // This spot was already tried, look for another
        // Move slightly to get different nearest results
        const pos = await getPosition();
        if (pos) {
          await exec(`/fac_move_to ${companionId} ${pos.x + (Math.random() * 10 - 5)} ${pos.y + (Math.random() * 10 - 5)}`);
          await sleep(1000);
        }
        nearest = await findNearest();
        searchAttempts++;
      }

      if (!nearest) {
        await say(`No more ${resource} found nearby.`);
        break;
      }

      const spotKey = `${nearest.position.x},${nearest.position.y}`;
      console.log(`[#${companionId}] Found ${resource} at (${nearest.position.x}, ${nearest.position.y}), distance: ${nearest.distance}`);

      // Walk to resource if needed
      if (nearest.distance > 5) {
        await say(`Walking to ${resource} (${Math.floor(nearest.distance)} tiles)...`);
        const arrived = await walkTo(nearest.position.x, nearest.position.y);
        if (!arrived) {
          console.log(`[#${companionId}] Failed to reach resource, marking as visited`);
          visitedSpots.add(spotKey);
          continue;
        }
      }

      // Start mining
      const toMine = Math.min(targetAmount - totalMined, 50);
      const started = await startMining(nearest.position.x, nearest.position.y, toMine);
      if (!started) {
        console.log(`[#${companionId}] Failed to start mining, marking spot as visited`);
        visitedSpots.add(spotKey);
        continue;
      }

      // Wait for mining to complete
      const harvested = await waitForMiningComplete();
      totalMined += harvested;

      console.log(`[#${companionId}] Mined ${harvested}, total: ${totalMined}/${targetAmount}`);

      // Track if we're stuck (mining 0 repeatedly)
      if (harvested === 0) {
        consecutiveZeroMines++;
        if (consecutiveZeroMines >= 3) {
          console.log(`[#${companionId}] Stuck at spot, marking as visited and moving on`);
          visitedSpots.add(spotKey);
          consecutiveZeroMines = 0;
          await say(`Spot depleted, looking for another...`);
        }
      } else {
        consecutiveZeroMines = 0;
        if (totalMined < targetAmount) {
          await say(`Minado ${totalMined}/${targetAmount}...`);
        }
      }
    }

    // Final report
    const finalCount = await getInventoryCount(resource);
    const success = finalCount >= targetAmount;
    await say(`Done! I have ${finalCount} ${resource} in inventory.`);
    console.log(`[#${companionId}] Done. Inventory: ${finalCount} ${resource}`);
    if (!success) process.exitCode = 1;
    console.log(`SKILL_RESULT ${JSON.stringify({
      skill: "mine-until",
      companionId,
      mined: finalCount,
      target: targetAmount,
      success,
    })}`);

  } catch (error) {
    console.error(`[#${companionId}] Error:`, error);
    try {
      await say(`Error during mining: ${error}`);
    } catch {}
    process.exitCode = 1;
    console.log(`SKILL_RESULT ${JSON.stringify({
      skill: "mine-until",
      companionId,
      mined: totalMined,
      target: targetAmount,
      success: false,
    })}`);
  } finally {
    await client.disconnect();
  }
}

main();
