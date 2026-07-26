// Single source of truth for all MCP tools
// Format: toolName -> { desc, rcon (template), params }
export const TOOLS: Record<string, {
  desc: string;
  rcon: string;  // Template with {param} placeholders
  params: Record<string, { type: "number" | "string" | "boolean"; desc?: string; required?: boolean; default?: any }>;
}> = {
  // Chat
  chat_get: {
    desc: "Get unread messages from Factorio chat",
    rcon: "/fac_chat_get {companionId}",
    params: { companionId: { type: "number", desc: "Optional: filter by companion ID" } }
  },
  chat_say: {
    desc: "Send a message to Factorio chat as a companion",
    rcon: "/fac_chat_say {companionId} {message}",
    params: {
      companionId: { type: "number", desc: "Companion ID (0 for orchestrator)", required: true },
      message: { type: "string", desc: "Message to send", required: true }
    }
  },

  // Companion
  companion_list: {
    desc: "List ALL companions with positions and health",
    rcon: "/fac_companion_list",
    params: {}
  },
  companion_spawn: {
    desc: "Spawn a new companion character",
    rcon: "/fac_companion_spawn id={companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  companion_position: {
    desc: "Get companion position and nearby entities",
    rcon: "/fac_companion_position {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  companion_inventory: {
    desc: "Get companion inventory contents",
    rcon: "/fac_companion_inventory {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  companion_health: {
    desc: "Get companion health status",
    rcon: "/fac_companion_health {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  companion_disappear: {
    desc: "Despawn a companion (drops items)",
    rcon: "/fac_companion_disappear {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  companion_stop_all: {
    desc: "Stop all queues for a companion (harvest, craft, build, combat, walk)",
    rcon: "/fac_companion_stop_all {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  // Movement
  move_to: {
    desc: "Move companion to specific coordinates",
    rcon: "/fac_move_to {companionId} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true }
    }
  },
  move_follow: {
    desc: "Make companion follow a player",
    rcon: "/fac_move_follow {companionId} {playerName}",
    params: {
      companionId: { type: "number", required: true },
      playerName: { type: "string", desc: "Player name to follow", required: true }
    }
  },
  move_stop: {
    desc: "Stop companion movement",
    rcon: "/fac_move_stop {companionId}",
    params: { companionId: { type: "number", required: true } }
  },

  // Resources
  resource_nearest: {
    desc: "Find nearest resource of a type",
    rcon: "/fac_resource_nearest {companionId} {resourceType}",
    params: {
      companionId: { type: "number", required: true },
      resourceType: { type: "string", desc: "Resource: iron-ore, copper-ore, coal, stone", required: true }
    }
  },
  resource_list: {
    desc: "List nearby resources around companion",
    rcon: "/fac_resource_list {companionId} {filter} {radius}",
    params: {
      companionId: { type: "number", required: true },
      filter: { type: "string", desc: "Optional: filter by resource type", default: "" },
      radius: { type: "number", desc: "Search radius", default: 50 }
    }
  },
  resource_mine: {
    desc: "Start mining at coordinates. Always enforced: companion must be within the engine's resource reach (~2.7 tiles on a default character), like a human player - a refusal returns {error:\"Too far\", target} to walk to and retry.",
    rcon: "/fac_resource_mine {companionId} {x} {y} {count} {resourceName}",
    params: {
      companionId: { type: "number", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true },
      count: { type: "number", desc: "Number to mine", default: 1 },
      resourceName: { type: "string", desc: "Optional: specific resource", default: "" }
    }
  },
  resource_mine_status: {
    desc: "Check mining queue status",
    rcon: "/fac_resource_mine_status {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  resource_mine_stop: {
    desc: "Stop mining queue (v0.11.0+: uses hybrid native mining)",
    rcon: "/fac_resource_mine_stop {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  // NOTE: mine_real_* removed in v0.11.0 - resource_mine now uses hybrid native mining

  // Items
  item_pick: {
    desc: "Pick up items from ground near companion",
    rcon: "/fac_item_pick {companionId} {itemName} {radius}",
    params: {
      companionId: { type: "number", required: true },
      itemName: { type: "string", required: true },
      radius: { type: "number", default: 10 }
    }
  },
  item_craft: {
    desc: "Craft an item (instant). By default the companion crafts from its own inventory, which does NOT register in the force's item production statistics (companions are controllerless characters) - so it can never satisfy a craft-item trigger technology. Set credited=true to have the connected player craft instead: it DOES register (needed for craft-item research triggers), but spends the player's own inventory and occupies the player's crafting queue.",
    rcon: "/fac_item_craft {companionId} {recipe} {count} {credited}",
    params: {
      companionId: { type: "number", required: true },
      recipe: { type: "string", required: true },
      count: { type: "number", default: 1 },
      credited: {
        type: "boolean",
        desc: "Craft as the connected player (credited toward production statistics) instead of the companion. Consumes the player's inventory and crafting queue. Default false = companion crafts as before.",
        required: false
      }
    }
  },
  item_craft_start: {
    desc: "Start crafting (async, tick-based)",
    rcon: "/fac_item_craft_start {companionId} {recipe} {count}",
    params: {
      companionId: { type: "number", required: true },
      recipe: { type: "string", required: true },
      count: { type: "number", default: 1 }
    }
  },
  item_craft_status: {
    desc: "Check crafting status",
    rcon: "/fac_item_craft_status {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  item_craft_stop: {
    desc: "Stop crafting",
    rcon: "/fac_item_craft_stop {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  item_recipes: {
    desc: "List available recipes for companion",
    rcon: "/fac_item_recipes {companionId}",
    params: { companionId: { type: "number", required: true } }
  },

  // World
  world_scan: {
    desc: "Scan for entities around companion",
    rcon: "/fac_world_scan {companionId} {radius} {entityType}",
    params: {
      companionId: { type: "number", required: true },
      radius: { type: "number", default: 50 },
      entityType: { type: "string", default: "" }
    }
  },
  world_nearest: {
    desc: "Find nearest entity of a type",
    rcon: "/fac_world_nearest {companionId} {entityName}",
    params: {
      companionId: { type: "number", required: true },
      entityName: { type: "string", required: true }
    }
  },
  world_enemies: {
    desc: "Find enemies around companion",
    rcon: "/fac_world_enemies {companionId} {radius}",
    params: {
      companionId: { type: "number", required: true },
      radius: { type: "number", default: 50 }
    }
  },

  // Building
  building_place: {
    desc: "Place a building/entity at coordinates (instant)",
    rcon: "/fac_building_place {companionId} {entityName} {x} {y} {direction}",
    params: {
      companionId: { type: "number", required: true },
      entityName: { type: "string", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true },
      direction: { type: "number", desc: "Direction 0-3", default: 0 }
    }
  },
  building_place_start: {
    desc: "Start placing a building (async, tick-based)",
    rcon: "/fac_building_place_start {companionId} {entityName} {x} {y} {direction}",
    params: {
      companionId: { type: "number", required: true },
      entityName: { type: "string", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true },
      direction: { type: "number", desc: "Direction 0-3 (N/E/S/W)", default: 0 }
    }
  },
  building_place_status: {
    desc: "Check building placement status",
    rcon: "/fac_building_place_status {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  building_remove: {
    desc: "Remove a building at coordinates",
    rcon: "/fac_building_remove {companionId} {entityName} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      entityName: { type: "string", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true }
    }
  },
  building_can_place: {
    desc: "Check if entity can be placed at coordinates",
    rcon: "/fac_building_can_place {companionId} {entityName} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      entityName: { type: "string", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true }
    }
  },
  building_info: {
    desc: "Get building info at coordinates",
    rcon: "/fac_building_info {companionId} {entityName} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      entityName: { type: "string", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true }
    }
  },
  building_rotate: {
    desc: "Rotate a building at coordinates",
    rcon: "/fac_building_rotate {companionId} {x} {y} {direction}",
    params: {
      companionId: { type: "number", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true },
      direction: { type: "number", desc: "Direction 0-3 (N/E/S/W)", required: true }
    }
  },
  building_recipe: {
    desc: "Get/set recipe for assembling machine",
    rcon: "/fac_building_recipe {companionId} {recipe} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true },
      recipe: { type: "string", required: true }
    }
  },
  building_fuel: {
    desc: "Add fuel to entity (burner, furnace, etc)",
    rcon: "/fac_building_fuel {companionId} {fuelName} {count} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      fuelName: { type: "string", required: true },
      count: { type: "number", required: true },
      x: { type: "number", required: false },
      y: { type: "number", required: false }
    }
  },
  building_empty: {
    desc: "Empty contents from entity",
    rcon: "/fac_building_empty {companionId} {itemName} {count} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      itemName: { type: "string", required: true },
      count: { type: "number", desc: "Amount to extract", required: false, default: 10 },
      x: { type: "number", required: false },
      y: { type: "number", required: false }
    }
  },
  building_fill: {
    desc: "Fill entity with items",
    rcon: "/fac_building_fill {companionId} {itemName} {count} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true },
      itemName: { type: "string", required: true },
      count: { type: "number", required: true }
    }
  },

  // Action/Combat
  action_attack: {
    desc: "Attack an entity at coordinates (instant)",
    rcon: "/fac_action_attack {companionId} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true }
    }
  },
  action_attack_start: {
    desc: "Start attacking (async, tick-based combat)",
    rcon: "/fac_action_attack_start {companionId} {x} {y}",
    params: {
      companionId: { type: "number", required: true },
      x: { type: "number", required: true },
      y: { type: "number", required: true }
    }
  },
  action_attack_status: {
    desc: "Check attack status",
    rcon: "/fac_action_attack_status {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  action_attack_stop: {
    desc: "Stop attacking",
    rcon: "/fac_action_attack_stop {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  action_defend: {
    desc: "Toggle the companion's auto_defend flag on/off (currently not read anywhere else in the mod - has no observable effect yet)",
    rcon: "/fac_action_defend {companionId} {enabled}",
    params: {
      companionId: { type: "number", required: true },
      enabled: { type: "boolean", desc: "true to enable, false to disable", required: true }
    }
  },
  action_flee: {
    desc: "Flee from danger",
    rcon: "/fac_action_flee {companionId} {distance}",
    params: {
      companionId: { type: "number", required: true },
      distance: { type: "number", required: true }
    }
  },
  action_patrol: {
    desc: "Patrol between points",
    rcon: "/fac_action_patrol {companionId} {points}",
    params: {
      companionId: { type: "number", required: true },
      points: { type: "string", desc: "JSON array of {x,y} points", required: true }
    }
  },
  action_wololo: {
    desc: "Play wololo sound",
    rcon: "/fac_action_wololo {companionId}",
    params: { companionId: { type: "number", required: true } }
  },

  // Research
  research_get: {
    desc: "Get current research status",
    rcon: "/fac_research_get {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  research_set: {
    desc: "Set research target",
    rcon: "/fac_research_set {companionId} {technology}",
    params: {
      companionId: { type: "number", required: true },
      technology: { type: "string", required: true }
    }
  },
  research_progress: {
    desc: "Get research progress",
    rcon: "/fac_research_progress {companionId}",
    params: { companionId: { type: "number", required: true } }
  },

  // Context
  context_clear: {
    desc: "Clear companion context (for thread management)",
    rcon: "/fac_context_clear {companionId}",
    params: { companionId: { type: "number", required: true } }
  },
  context_check: {
    desc: "Check pending context clear requests",
    rcon: "/fac_context_check",
    params: {}
  },

  // Meta
  version: {
    desc: "Get mod version",
    rcon: "/fac_version",
    params: {}
  },
  help: {
    desc: "Get help and list of commands",
    rcon: "/fac_help {category}",
    params: {
      category: { type: "string", desc: "Optional: category to filter (action, building, etc)", default: "" }
    }
  },
};

// High-level skills (run as background processes, not direct RCON)
export const SKILLS: Record<string, {
  desc: string;
  script: string;  // Script path relative to src/
  params: Record<string, { type: "number" | "string"; desc?: string; required?: boolean; default?: any }>;
}> = {
  resource_mine_until: {
    desc: "HIGH-LEVEL: Autonomously mine resource until target amount. Handles walking, mining, repeat. Runs in background.",
    script: "skills/mine-until.ts",
    params: {
      companionId: { type: "number", required: true },
      resource: { type: "string", desc: "Resource: iron, copper, coal, stone, uranium", required: true },
      amount: { type: "number", desc: "Target amount", default: 50 }
    }
  },
  combat_until: {
    desc: "HIGH-LEVEL: Autonomously hunt and kill enemies. Handles scanning, walking, attacking. Runs in background.",
    script: "skills/combat-until.ts",
    params: {
      companionId: { type: "number", required: true },
      targetType: { type: "string", desc: "Target: all, spawner, worm, biter, spitter", default: "all" },
      maxKills: { type: "number", desc: "Max kills before stopping", default: 10 }
    }
  },
};

// Special tools that need TS-side handling (not just RCON passthrough)
const SPECIAL_TOOLS = [
  {
    name: "session_status",
    description: "Get current session state and instructions. Call this FIRST to understand what's running and how to start the reactive loop.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: []
    }
  },
  {
    name: "companion_status",
    description: "Get status of ONE companion including running skill (combines Lua position + TS skill tracking).",
    inputSchema: {
      type: "object" as const,
      properties: {
        companionId: { type: "number", description: "Companion ID to check" }
      },
      required: ["companionId"]
    }
  },
  {
    name: "companion_stop",
    description: "Stop a running skill for ONE companion (kills the background process).",
    inputSchema: {
      type: "object" as const,
      properties: {
        companionId: { type: "number", description: "Companion whose skill to stop" }
      },
      required: ["companionId"]
    }
  },
  {
    name: "build_smelter_line",
    description: "HIGH-LEVEL: Build a line of furnaces each with a feeding inserter. Synchronous - returns structured placement results.",
    inputSchema: {
      type: "object" as const,
      properties: {
        companionId: { type: "number", description: "Companion ID" },
        x: { type: "number", description: "Start X coordinate" },
        y: { type: "number", description: "Start Y coordinate" },
        count: { type: "number", description: "Number of furnaces to place" },
        furnaceType: { type: "string", description: "stone-furnace | steel-furnace | electric-furnace" },
        direction: { type: "string", description: "horizontal | vertical" },
        inputSide: { type: "string", description: "left | right | top | bottom" }
      },
      required: ["companionId", "x", "y", "count"]
    }
  }
];

// Generate skill schemas (includes SKILLS + skill management tools)
export function generateSkillSchemas() {
  const skillSchemas = Object.entries(SKILLS).map(([name, skill]) => ({
    name,
    description: skill.desc,
    inputSchema: {
      type: "object" as const,
      properties: Object.fromEntries(
        Object.entries(skill.params).map(([pName, p]) => [
          pName,
          { type: p.type, description: p.desc }
        ])
      ),
      required: Object.entries(skill.params)
        .filter(([_, p]) => p.required)
        .map(([name]) => name)
    }
  }));

  return [...skillSchemas, ...SPECIAL_TOOLS];
}

// Generate MCP tool schemas from TOOLS
export function generateToolSchemas() {
  return Object.entries(TOOLS).map(([name, tool]) => ({
    name,
    description: tool.desc,
    inputSchema: {
      type: "object" as const,
      properties: Object.fromEntries(
        Object.entries(tool.params).map(([pName, p]) => [
          pName,
          { type: p.type, description: p.desc }
        ])
      ),
      required: Object.entries(tool.params)
        .filter(([_, p]) => p.required)
        .map(([name]) => name)
    }
  }));
}

// Build RCON command from template and args
export function buildRCONCommand(toolName: string, args: Record<string, any>): string {
  const tool = TOOLS[toolName];
  if (!tool) return ""; // Return empty for unknown tools (handled separately)

  // Single pass over the template via a regex replacer - immune to
  // $-expansion (String.replace treats a literal replacement string specially)
  // and to param values that themselves contain "{otherParam}".
  const missing: string[] = [];
  const cmd = tool.rcon.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const param = tool.params[name];
    const value = args[name] ?? param?.default;
    if (value === undefined) {
      if (param?.required) missing.push(name);
      return "";
    }
    return String(value);
  });

  if (missing.length) {
    throw new Error(`Missing required argument(s): ${missing.join(", ")}`);
  }

  // Clean up extra spaces
  return cmd.replace(/\s+/g, " ").trim();
}
