import { RCONClient } from "../rcon/client";

export interface ConnectionConfig {
  host: string;
  port: number;
  password: string;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// helpers.table_to_json (Lua side) serializes an EMPTY Lua table as JSON `{}`, not `[]` -
// Lua can't tell "empty array" from "empty map" without elements to inspect. Every RCON
// response field that represents a list must be coerced through this before any array
// method (.sort, .filter, .length, for...of, spread, indexing) is used on it.
export function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export async function connectWithRetry(
  client: RCONClient,
  maxRetries: number = 3,
  initialDelay: number = 1000
): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await client.connect();
      console.error(`✅ RCON connected on attempt ${attempt}`);
      return;
    } catch (error) {
      console.error(`❌ RCON connection attempt ${attempt} failed:`, error);

      if (attempt === maxRetries) {
        throw new Error(`Failed to connect after ${maxRetries} attempts`);
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, etc.
      const delay = initialDelay * Math.pow(2, attempt - 1);
      await sleep(delay);
    }
  }
}
