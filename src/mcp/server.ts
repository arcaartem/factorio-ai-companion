import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { mkdirSync, openSync, closeSync } from "fs";
import { join } from "path";
import { RCONClient } from "../rcon/client";
import { buildSmelterLine } from "../skills/build-smelter-line";
import { TOOLS, SKILLS, generateToolSchemas, generateSkillSchemas, buildRCONCommand } from "./tools";

const SKILLS_LOG_DIR = ".fac-skills";

// Track running skills by companionId
interface RunningSkill {
  pid: number;
  skillName: string;
  startTime: number;
  logPath: string;
}
const runningSkills = new Map<number, RunningSkill>();

// Last completed skill run per companionId, so a caller can find out what
// happened after the fact (background skills otherwise report nothing back).
interface SkillRunResult {
  skillName: string;
  exitCode: number | null;
  endedAt: number;
  logPath: string;
}
const lastSkillResults = new Map<number, SkillRunResult>();

export class FactorioMCPServer {
  private server: Server;
  private rcon: RCONClient;

  constructor(rconConfig: { host: string; port: number; password: string }) {
    this.server = new Server(
      {
        name: "factorio-companion",
        version: "0.13.3",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.rcon = new RCONClient(rconConfig);
    this.setupHandlers();
  }

  private setupHandlers() {
    // Generate all tool schemas from single source of truth
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [...generateToolSchemas(), ...generateSkillSchemas()],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments as Record<string, any>;
      const toolName = request.params.name;

      // Helper to execute RCON and return formatted response
      const execRCON = async (command: string) => {
        const response = await this.rcon.sendCommand(command);
        return {
          content: [{
            type: "text" as const,
            text: response.success ? (response.data || "OK") : `Error: ${response.error}`
          }]
        };
      };

      // Helper to stop a companion's running skill (TS + Lua).
      // stopWalk=false for move_to/move_follow: start_walk already cancels any existing
      // request itself, and it answers a repeated same-target call with current progress
      // (queues.lua:154-158). Sending /fac_move_stop first deletes the very queue that
      // poll reads, so every poll restarted the pathfind instead of reporting progress.
      const stopCompanionSkill = async (companionId: number, stopWalk: boolean): Promise<string | null> => {
        const skill = runningSkills.get(companionId);

        // Harvest/craft queues can exist with no TS process behind them (resource_mine and
        // item_craft_start are plain tools), so clear those regardless of `skill`.
        await this.rcon.sendCommand(`/fac_resource_mine_stop ${companionId}`);
        await this.rcon.sendCommand(`/fac_item_craft_stop ${companionId}`);
        if (stopWalk) {
          await this.rcon.sendCommand(`/fac_move_stop ${companionId}`);
        }

        if (!skill) {
          return null; // No TS skill was running
        }

        // Kill the TS process. Record the outcome here rather than leaving it to the exit
        // handler, which deliberately ignores a process it no longer tracks (see below).
        runningSkills.delete(companionId);
        let msg: string;
        try {
          process.kill(skill.pid);
          msg = `Stopped ${skill.skillName} (pid ${skill.pid})`;
        } catch (e) {
          msg = `Process ${skill.pid} already dead`;
        }
        lastSkillResults.set(companionId, {
          skillName: skill.skillName,
          exitCode: null, // killed, not self-terminated
          endedAt: Date.now(),
          logPath: skill.logPath
        });
        return msg;
      };

      // Tools that require stopping active skills before execution
      const AUTO_STOP_TOOLS = [
        'move_to', 'move_follow',
        'action_attack', 'action_flee', 'action_patrol'
      ];
      // ...of which these supersede an existing walk on their own; the rest want it cleared.
      const SELF_SUPERSEDING_MOVE_TOOLS = ['move_to', 'move_follow'];

      // Check if it's a regular RCON tool
      if (TOOLS[toolName]) {
        // Auto-stop skills for movement/action commands
        if (AUTO_STOP_TOOLS.includes(toolName) && args.companionId !== undefined) {
          const stopMsg = await stopCompanionSkill(
            args.companionId as number,
            !SELF_SUPERSEDING_MOVE_TOOLS.includes(toolName)
          );
          if (stopMsg) {
            console.error(`[Auto-stop] ${stopMsg} for ${toolName}`);
          }
        }

        let cmd: string;
        try {
          cmd = buildRCONCommand(toolName, args);
        } catch (error) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: ${error instanceof Error ? error.message : String(error)}`
            }]
          };
        }
        return execRCON(cmd);
      }

      // Check if it's a skill (background process)
      if (SKILLS[toolName]) {
        const skill = SKILLS[toolName];
        const companionId = args.companionId as number;

        // Check if companion already has a running skill
        const existing = runningSkills.get(companionId);
        if (existing) {
          return {
            content: [{
              type: "text" as const,
              text: `Companion ${companionId} already running ${existing.skillName} (pid ${existing.pid}). Stop it first with skill_stop.`
            }]
          };
        }

        // Build args array from params
        const scriptArgs = Object.entries(skill.params).map(([name, config]) => {
          const value = args[name] ?? config.default ?? "";
          return String(value);
        });

        mkdirSync(SKILLS_LOG_DIR, { recursive: true });
        const logPath = join(SKILLS_LOG_DIR, `${companionId}-${toolName}-${Date.now()}.log`);
        const logFd = openSync(logPath, "a");

        const proc = spawn("bun", ["run", `src/${skill.script}`, ...scriptArgs], {
          cwd: process.cwd(),
          detached: true,
          stdio: ["ignore", logFd, logFd]
        });
        closeSync(logFd); // the child holds its own duped descriptor now

        // Track the running skill
        runningSkills.set(companionId, {
          pid: proc.pid!,
          skillName: toolName,
          startTime: Date.now(),
          logPath
        });

        // Clean up when process exits. The guard matters: `exit` fires asynchronously, so a
        // skill killed by stopCompanionSkill can emit it *after* a replacement skill has
        // already registered for the same companion. Keyed on companionId alone that deletes
        // the newcomer's entry — leaving a live process untracked, so the "already running"
        // check below silently allows a second concurrent skill — and reports the dead
        // skill's exit code as the companion's latest result.
        proc.on("exit", (code) => {
          if (runningSkills.get(companionId)?.pid !== proc.pid) return;
          runningSkills.delete(companionId);
          lastSkillResults.set(companionId, {
            skillName: toolName,
            exitCode: code,
            endedAt: Date.now(),
            logPath
          });
        });

        proc.unref();

        return {
          content: [{
            type: "text" as const,
            text: `Started ${toolName} for companion ${companionId} (pid ${proc.pid})`
          }]
        };
      }

      // session_status - get current state and instructions
      if (toolName === "session_status") {
        // Get companions from Lua
        const companionsResponse = await this.rcon.sendCommand("/fac_companion_list");
        let companions: any = {};
        try {
          companions = companionsResponse.success ? JSON.parse(companionsResponse.data || "{}") : {};
        } catch { /* ignore parse errors */ }

        // Get running skills from TS
        const skills: Record<number, RunningSkill> = {};
        runningSkills.forEach((skill, id) => {
          skills[id] = skill;
        });

        const lastResults: Record<number, SkillRunResult> = {};
        lastSkillResults.forEach((result, id) => {
          lastResults[id] = result;
        });

        const status = {
          companions: companions.companions || {},
          companionCount: companions.count || 0,
          runningSkills: skills,
          lastSkillResults: lastResults,
          instructions: {
            step1: "Spawn companions: companion_spawn(companionId: 1)",
            step2: "Start reactive loop: Bash(run_in_background: true): bun run src/reactive-all.ts",
            step3: "Poll messages: TaskOutput(task_id, block: true, timeout: 120000)",
            step4: "Parse JSON array, respond with chat_say + actions, repeat from step2"
          },
          reactiveLoopCommand: "bun run src/reactive-all.ts"
        };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(status, null, 2)
          }]
        };
      }

      // companion_status - get companion position + running skill
      if (toolName === "companion_status") {
        const companionId = args.companionId as number;

        // Get position from Lua
        const posResponse = await this.rcon.sendCommand(`/fac_companion_position ${companionId}`);
        let position = null;
        try {
          position = JSON.parse(posResponse.data || "{}");
        } catch {}

        // Get skill status from TS tracking
        const skill = runningSkills.get(companionId);
        const skillInfo = skill ? {
          running: true,
          skillName: skill.skillName,
          pid: skill.pid,
          elapsedSeconds: Math.floor((Date.now() - skill.startTime) / 1000)
        } : { running: false };

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...position,
              skill: skillInfo,
              lastSkillResult: lastSkillResults.get(companionId) ?? null
            })
          }]
        };
      }

      // companion_stop - kill a running skill AND clear Lua queues
      if (toolName === "companion_stop") {
        const companionId = args.companionId as number;
        const stopMsg = await stopCompanionSkill(companionId, true);

        if (!stopMsg) {
          return {
            content: [{ type: "text" as const, text: `No TS skill running for companion ${companionId}. Cleared Lua queues.` }]
          };
        }

        return {
          content: [{
            type: "text" as const,
            text: `${stopMsg}. Cleared Lua queues.`
          }]
        };
      }

      // build_smelter_line - synchronous placement, runs instantly (no background process)
      if (toolName === "build_smelter_line") {
        const { companionId, x, y, count, furnaceType, direction, inputSide } = args;
        if (companionId === undefined || x === undefined || y === undefined || count === undefined) {
          return {
            content: [{
              type: "text" as const,
              text: "Error: Missing required argument(s): companionId, x, y, count"
            }]
          };
        }

        const result = await buildSmelterLine(
          { rcon: this.rcon, companionId },
          { start: { x, y }, count, furnaceType, direction, inputSide }
        );

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }]
        };
      }

      throw new Error(`Unknown tool: ${toolName}`);
    });
  }

  // NOTE: this server deliberately does NOT poll /fac_chat_get. That command is a
  // destructive drain, so a second poller does not observe messages - it steals them.
  // This server used to drain every 3s alongside reactive-all.ts's 100ms loop, and each
  // message went to whichever polled first; the ones this server won became MCP
  // notifications that the documented orchestrator loop never reads, so they were simply
  // lost. reactive-all.ts is the sole drainer and owns .fac-messages.jsonl.

  async start() {
    console.error("Starting Factorio MCP Server...");
    await this.rcon.connect();
    console.error("RCON connected");

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("MCP server running on stdio");
    console.error("Chat is drained by reactive-all.ts, not this server.");
  }

  async stop() {
    await this.rcon.disconnect();
  }
}
