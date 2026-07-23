// AI Companion Skills - High-level behaviors composed from RCON commands
// Inspired by FLE (Factorio Learning Environment)

import { RCONClient } from "../rcon/client";

export interface Position {
  x: number;
  y: number;
}

export interface SkillResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface SkillContext {
  rcon: RCONClient;
  companionId: number;
}

// Parse JSON response from RCON, handle errors
export function parseResponse(response: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(response);
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed;
  } catch (e) {
    if (e instanceof SyntaxError) {
      throw new Error(`Invalid JSON response: ${response}`);
    }
    throw e;
  }
}

// Execute RCON command and parse response
export async function exec(
  ctx: SkillContext,
  command: string
): Promise<Record<string, unknown>> {
  const response = await ctx.rcon.sendCommand(command);
  if (!response.success) {
    throw new Error(response.error || "Command failed");
  }
  return parseResponse(response.data);
}

// Export skills
export { buildSmelterLine } from "./build-smelter-line";
