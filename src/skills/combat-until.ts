#!/usr/bin/env bun
import { RCONClient } from "../rcon/client";
import { getRCONConfig } from "../config";
import { sleep } from "../utils/connection";

const POLL_INTERVAL = 500;
const ATTACK_RANGE = 6;
const SCAN_RADIUS = 50;

const companionId = parseInt(process.argv[2]);
const targetType = process.argv[3] || "all"; // all, spawner, worm, biter, spitter
const parsedMaxKills = parseInt(process.argv[4]);
const maxKills = process.argv[4] === undefined || isNaN(parsedMaxKills) ? 10 : parsedMaxKills;

if (!companionId) {
  console.error("Usage: bun run src/skills/combat-until.ts <companionId> [targetType] [maxKills]");
  process.exit(1);
}

const client = new RCONClient(getRCONConfig());

class CompanionGoneError extends Error {}

// Tracks consecutive failed position/health reads. Either signal counts
// toward the same streak - after MAX_NULL_READS in a row the companion is
// treated as dead/gone (destroyed entity => "Companion not found" upstream).
const MAX_NULL_READS = 3;
let nullReadStreak = 0;

function trackAliveness(gotReading: boolean): void {
  if (gotReading) {
    nullReadStreak = 0;
    return;
  }
  nullReadStreak++;
  if (nullReadStreak >= MAX_NULL_READS) {
    throw new CompanionGoneError(`No position/health reading for ${companionId} after ${nullReadStreak} attempts`);
  }
}

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

async function stopAll(): Promise<void> {
  await exec(`/fac_companion_stop_all ${companionId}`);
}

async function getPosition(): Promise<{x: number, y: number} | null> {
  const data = await exec(`/fac_companion_position ${companionId}`);
  const pos = data?.position || null;
  trackAliveness(pos !== null);
  return pos;
}

async function getHealth(): Promise<{health: number, max: number, pct: number} | null> {
  const data = await exec(`/fac_companion_health ${companionId}`);
  const health = data?.self || null;
  trackAliveness(health !== null);
  return health;
}

interface Enemy {
  name: string;
  type: string;
  position: {x: number, y: number};
  health: number;
  distance: number;
}

async function scanEnemies(): Promise<Enemy[]> {
  const data = await exec(`/fac_world_enemies ${companionId} ${SCAN_RADIUS}`);
  if (!data?.enemies) return [];

  let enemies = data.enemies as Enemy[];

  if (targetType !== "all") {
    enemies = enemies.filter((e: Enemy) => {
      if (targetType === "spawner") return e.type === "unit-spawner";
      if (targetType === "worm") return e.type === "turret";
      if (targetType === "biter") return e.name.includes("biter");
      if (targetType === "spitter") return e.name.includes("spitter");
      return true;
    });
  }

  return enemies.sort((a, b) => a.distance - b.distance);
}

async function walkTo(x: number, y: number): Promise<boolean> {
  await exec(`/fac_move_to ${companionId} ${x} ${y}`);

  const startTime = Date.now();
  const timeout = 30000;

  while (Date.now() - startTime < timeout) {
    const pos = await getPosition();
    if (!pos) break;

    const dist = Math.sqrt(Math.pow(pos.x - x, 2) + Math.pow(pos.y - y, 2));
    if (dist < ATTACK_RANGE) return true;

    await sleep(POLL_INTERVAL);
  }
  return false;
}

async function attack(
  x: number,
  y: number,
  startPos: {x: number, y: number} | null
): Promise<{kills: number, retreated: boolean}> {
  const result = await exec(`/fac_action_attack_start ${companionId} ${x} ${y}`);
  if (!result?.started) return {kills: 0, retreated: false};

  let totalKills = 0;
  const startTime = Date.now();
  const timeout = 60000;

  while (Date.now() - startTime < timeout) {
    const status = await exec(`/fac_action_attack_status ${companionId}`);
    totalKills = status?.status?.kills ?? totalKills;

    if (!status?.status?.active) {
      break;
    }

    const health = await getHealth();
    if (health && health.pct < 30) {
      await exec(`/fac_action_attack_stop ${companionId}`);
      await say("Health low, retreating!");
      if (startPos) {
        await walkTo(startPos.x, startPos.y);
      }
      return {kills: totalKills, retreated: true};
    }

    await sleep(POLL_INTERVAL);
  }

  return {kills: totalKills, retreated: false};
}

async function main(): Promise<void> {
  let totalKills = 0;
  let outcome: "success" | "retreated" | "no-targets" | "max-attempts" | "gone" | "error" = "success";

  try {
    await client.connect();
    console.log(`[Companion #${companionId}] Starting combat: ${targetType}, max ${maxKills} kills`);

    const startPos = await getPosition();

    await stopAll();
    await say(`Combat mode: hunting ${targetType}!`);

    let attempts = 0;
    const maxAttempts = 30;

    while (totalKills < maxKills && attempts < maxAttempts) {
      attempts++;

      const enemies = await scanEnemies();
      if (enemies.length === 0) {
        await say(`No more ${targetType} enemies in range.`);
        outcome = "no-targets";
        break;
      }

      const target = enemies[0];
      console.log(`[#${companionId}] Target: ${target.name} at (${target.position.x}, ${target.position.y}), dist: ${target.distance}`);

      if (target.distance > ATTACK_RANGE) {
        await say(`Moving to ${target.name} (${Math.floor(target.distance)} tiles)...`);
        const arrived = await walkTo(target.position.x, target.position.y);
        if (!arrived) {
          console.log(`[#${companionId}] Failed to reach target`);
          continue;
        }
      }

      await say(`Attacking ${target.name}!`);
      const result = await attack(target.position.x, target.position.y, startPos);
      totalKills += result.kills;

      console.log(`[#${companionId}] Kills this round: ${result.kills}, total: ${totalKills}`);

      if (result.kills > 0) {
        await say(`Killed ${result.kills}! Total: ${totalKills}/${maxKills}`);
      }

      if (result.retreated) {
        outcome = "retreated";
        console.log(`[#${companionId}] Retreated to start position after ${totalKills} kills.`);
        break;
      }

      await sleep(500);
    }

    if (outcome === "success" && attempts >= maxAttempts && totalKills < maxKills) {
      outcome = "max-attempts";
    }

    if (outcome !== "retreated") {
      await say(`Combat done! ${totalKills} kills.`);
      console.log(`[#${companionId}] Combat complete. Total kills: ${totalKills}`);
    }

    if (outcome !== "success") {
      process.exitCode = 1;
    }
  } catch (error) {
    if (error instanceof CompanionGoneError) {
      outcome = "gone";
      console.error(`[#${companionId}] Companion gone: ${error.message}`);
    } else {
      outcome = "error";
      console.error(`[#${companionId}] Error:`, error);
      try {
        await say(`Error: ${error}`);
      } catch {}
    }
    process.exitCode = 1;
  } finally {
    console.log(`SKILL_RESULT ${JSON.stringify({
      skill: "combat-until",
      companionId,
      kills: totalKills,
      target: maxKills,
      outcome,
      success: outcome === "success",
    })}`);
    await client.disconnect();
  }
}

main();
