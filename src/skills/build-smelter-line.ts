// Skill: Build Smelter Line
// Creates a line of furnaces with inserters for automated smelting

import { SkillContext, SkillResult, Position, exec } from "./index";

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

  for (let i = 0; i < count; i++) {
    const furnacePos: Position = {
      x: start.x + dx * i,
      y: start.y + dy * i,
    };

    const inserterPos: Position = {
      x: furnacePos.x + inserterOffset.x,
      y: furnacePos.y + inserterOffset.y,
    };

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

  const success = furnacesPlaced > 0;
  const message = success
    ? `Built smelter line: ${furnacesPlaced} furnace(s), ${insertersPlaced} inserter(s)${errors.length ? `, ${errors.length} errors` : ""}`
    : `Failed to build smelter line: ${errors.join("; ")}`;

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
