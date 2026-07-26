// Skill: Build Smelter Line
// Creates a line of furnaces with inserters for automated smelting

import { SkillContext, SkillResult, Position, exec } from "./index";
import { sleep } from "../utils/connection";

const POLL_INTERVAL = 500;
const WALK_TIMEOUT = 30000;
// A walk can be pinned indefinitely while the mod's queue still reports status:"walking" - an
// active harvest queue does exactly this (mining_state holds the character in place, and the
// queue only self-aborts once the companion moves out of resource reach, which it never can).
// Waiting out WALK_TIMEOUT per furnace blows past the MCP client's 60s request timeout, so a
// walk that is going nowhere has to be detected by lack of ground covered. A character runs
// ~9 tiles/s, so 10s without half a tile of net progress is not a slow walk, it is a stuck one.
const NO_PROGRESS_TIMEOUT = 10000;
const NO_PROGRESS_MIN_DIST = 0.5;
// queues.lua stops walking at ARRIVE_DIST 1.5, so anything tighter than that would spin until
// the timeout. 2 is the smallest value the mod can actually satisfy, and it has to be small:
// the arrival slop eats into STANDOFF below.
const ARRIVAL_THRESHOLD = 2;
// Stand BESIDE the line, never on it. Walking onto a furnace's own tile leaves the companion's
// collision box inside the NEXT furnace's 2x2 footprint, and can_place then refuses it - live
// probe: furnace 1 placed, furnace 2 came back "blocked" with the companion 0.7 tiles inside it.
// STANDOFF - ARRIVAL_THRESHOLD is the guaranteed clearance from the line (2 tiles here).
const STANDOFF = 4;
// reach_distance is 10 (engine, always enforced). Only re-walk when a furnace/inserter pair is
// genuinely out of reach, with margin - a short line is then built from one standing spot.
const SAFE_BUILD_DIST = 8;

async function getPosition(ctx: SkillContext): Promise<Position | null> {
  const data = await exec(ctx, `/fac_companion_position ${ctx.companionId}`);
  return (data?.position as Position | undefined) ?? null;
}

async function walkTo(ctx: SkillContext, x: number, y: number): Promise<boolean> {
  await exec(ctx, `/fac_move_to ${ctx.companionId} ${x} ${y}`);

  const startTime = Date.now();
  let bestDist = Infinity;
  let bestAt = Date.now();

  while (Date.now() - startTime < WALK_TIMEOUT) {
    const pos = await getPosition(ctx);
    if (!pos) return false;

    const dist = Math.sqrt((pos.x - x) ** 2 + (pos.y - y) ** 2);
    if (dist < ARRIVAL_THRESHOLD) return true;

    if (dist < bestDist - NO_PROGRESS_MIN_DIST) {
      bestDist = dist;
      bestAt = Date.now();
    } else if (Date.now() - bestAt > NO_PROGRESS_TIMEOUT) {
      return false;
    }

    await sleep(POLL_INTERVAL);
  }
  return false;
}

export interface SmelterLineOptions {
  start: Position;
  count: number;
  furnaceType?: "stone-furnace" | "steel-furnace" | "electric-furnace";
  direction?: "horizontal" | "vertical";
  inputSide?: "left" | "right" | "top" | "bottom";
}

export async function buildSmelterLine(
  ctx: SkillContext,
  options: SmelterLineOptions
): Promise<SkillResult> {
  const {
    start,
    count,
    furnaceType = "stone-furnace",
    direction = "horizontal",
    inputSide = "left",
  } = options;

  const id = ctx.companionId;
  const placed: string[] = [];
  const errors: string[] = [];
  let furnacesPlaced = 0;
  let insertersPlaced = 0;

  // Calculate spacing based on furnace size (2x2 for all furnace types)
  const spacing = 2;
  const dx = direction === "horizontal" ? spacing : 0;
  const dy = direction === "vertical" ? spacing : 0;

  // Calculate inserter offset based on input side
  const inserterOffset: Position = {
    x: inputSide === "left" ? -1 : inputSide === "right" ? 1 : 0,
    y: inputSide === "top" ? -1 : inputSide === "bottom" ? 1 : 0,
  };

  // Inserter direction: points toward furnace
  // 0=N, 1=E, 2=S, 3=W
  const inserterDir =
    inputSide === "left" ? 1 : inputSide === "right" ? 3 : inputSide === "top" ? 2 : 0;

  // Where to stand relative to the furnace being placed: perpendicular to the line (so the
  // companion is never inside a later furnace's footprint) and on the opposite side from the
  // inserters (so it is never inside theirs either).
  const standoff: Position =
    direction === "horizontal"
      ? { x: 0, y: (inserterOffset.y !== 0 ? -Math.sign(inserterOffset.y) : 1) * STANDOFF }
      : { x: (inserterOffset.x !== 0 ? -Math.sign(inserterOffset.x) : 1) * STANDOFF, y: 0 };

  for (let i = 0; i < count; i++) {
    const furnacePos: Position = {
      x: start.x + dx * i,
      y: start.y + dy * i,
    };

    const inserterPos: Position = {
      x: furnacePos.x + inserterOffset.x,
      y: furnacePos.y + inserterOffset.y,
    };

    // A line of any length quickly exceeds build_distance (10) from a single fixed spot, so
    // walk - but only when this pair is actually out of reach, and to a spot BESIDE the line
    // rather than on it (see STANDOFF).
    const here = await getPosition(ctx);
    const outOfReach =
      !here ||
      Math.sqrt((here.x - furnacePos.x) ** 2 + (here.y - furnacePos.y) ** 2) > SAFE_BUILD_DIST ||
      Math.sqrt((here.x - inserterPos.x) ** 2 + (here.y - inserterPos.y) ** 2) > SAFE_BUILD_DIST;

    if (outOfReach) {
      const standX = furnacePos.x + standoff.x;
      const standY = furnacePos.y + standoff.y;
      const arrived = await walkTo(ctx, standX, standY);
      if (!arrived) {
        errors.push(`Failed to walk to (${standX}, ${standY}) to build at (${furnacePos.x}, ${furnacePos.y})`);
        continue;
      }
    }

    // Check if we can place the furnace
    try {
      const canPlace = await exec(
        ctx,
        `/fac_building_can_place ${id} ${furnaceType} ${furnacePos.x} ${furnacePos.y}`
      );

      if (!canPlace.can_place) {
        errors.push(`Cannot place ${furnaceType} at (${furnacePos.x}, ${furnacePos.y}): ${canPlace.reason || "blocked"}`);
        continue;
      }
    } catch (e) {
      errors.push(`Check failed for furnace at (${furnacePos.x}, ${furnacePos.y}): ${e}`);
      continue;
    }

    // Place the furnace
    try {
      await exec(ctx, `/fac_building_place ${id} ${furnaceType} ${furnacePos.x} ${furnacePos.y}`);
      placed.push(`${furnaceType} at (${furnacePos.x}, ${furnacePos.y})`);
      furnacesPlaced++;
    } catch (e) {
      errors.push(`Failed to place ${furnaceType} at (${furnacePos.x}, ${furnacePos.y}): ${e}`);
      continue;
    }

    // Place the inserter
    try {
      const canPlaceInserter = await exec(
        ctx,
        `/fac_building_can_place ${id} inserter ${inserterPos.x} ${inserterPos.y} ${inserterDir}`
      );

      if (canPlaceInserter.can_place) {
        await exec(
          ctx,
          `/fac_building_place ${id} inserter ${inserterPos.x} ${inserterPos.y} ${inserterDir}`
        );
        placed.push(`inserter at (${inserterPos.x}, ${inserterPos.y})`);
        insertersPlaced++;
      } else {
        errors.push(`Cannot place inserter at (${inserterPos.x}, ${inserterPos.y})`);
      }
    } catch (e) {
      errors.push(`Failed to place inserter at (${inserterPos.x}, ${inserterPos.y}): ${e}`);
    }
  }

  // A partially-placed line is not success - the caller asked for `count` furnaces and needs
  // to know if the line is actually complete, not just that something got placed.
  const success = furnacesPlaced === count;
  const message = success
    ? `Built smelter line: ${furnacesPlaced} furnace(s), ${insertersPlaced} inserter(s)${errors.length ? `, ${errors.length} errors` : ""}`
    : `Built ${furnacesPlaced}/${count} furnaces (incomplete line): ${errors.join("; ")}`;

  return {
    success,
    message,
    data: {
      furnacesPlaced,
      insertersPlaced,
      requested: count,
      placed,
      errors,
      furnaceType,
    },
  };
}
