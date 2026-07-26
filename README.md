# Factorio AI Companion

AI companions for Factorio 2.x, driven by an orchestrating agent (Claude Code) over
MCP tools + RCON, with a Lua mod running the game-side logic.

## What this is

A Factorio mod exposes `/fac_*` RCON commands (chat, movement, mining, crafting,
building, combat, research, world queries). An MCP server on the Node/Bun side
mirrors each of those 1:1 as a typed tool, plus a few higher-level "skills" and
special tools. An orchestrating agent spawns and directs companions by calling
these tools and reacting to in-game chat.

## Architecture

```
Factorio (Lua mod: factorio-mod/commands/*.lua)
    ↕ RCON (src/rcon/client.ts — length-prefixed packet framing, auto-reconnect)
MCP Server (src/mcp/server.ts, tools defined in src/mcp/tools.ts)
    ↕ MCP Protocol (stdio)
Orchestrating agent (Claude Code)
```

- **53 RCON-mirrored tools** (`TOOLS` in `src/mcp/tools.ts`) — thin, validated
  wrappers around each `fac_*` Lua command: `chat_*`, `companion_*`, `move_*`,
  `resource_*`, `item_*`, `building_*`, `action_*`, `research_*`, `world_*`,
  `context_*`. Run `bun run scripts/validate-tools.ts` to confirm the TS and
  Lua sides still match 1:1 (arity and argument order included).
- **Background skills** (`SKILLS` in `src/mcp/tools.ts`, scripts in
  `src/skills/`) — long-running, multi-step behaviors spawned as background
  processes: `resource_mine_until` (walk/mine/repeat to a target amount) and
  `combat_until` (scan/walk/attack to a kill target). `companion_status` /
  `companion_stop` track and can kill a running skill process.
- **`build_smelter_line`** — a synchronous special tool: since placement
  commands are instant, it runs to completion and returns a structured
  placement result rather than spawning a background process.
- **Other special tools** — `session_status`, `companion_status`,
  `companion_stop` need TS-side state (not a plain RCON passthrough) and are
  handled directly in `server.ts`.
- **Reactive loop** (`src/reactive-all.ts`) — the orchestrator's inbox: polls
  `/fac_chat_get` for all companions, prints unread messages as a JSON array,
  appends every message to `.fac-messages.jsonl` as a durable audit log (the
  drain is destructive on the Lua side, so this file is the record), and
  exits once there's something to report. See `CLAUDE.md` for how the
  orchestrator drives this loop.
- **Lua mod** (`factorio-mod/commands/`) — implements the `fac_*` commands.
  Instant actions run inline; multi-tick actions (harvest, craft, build,
  combat, walk) are tracked in per-companion queues advanced every tick.

## Setup

1. **Install dependencies:** `bun install`
2. **Install the mod:** copy `factorio-mod/` into your Factorio mods folder
   as `ai-companion` (Windows: `%APPDATA%\Factorio\mods\ai-companion`; see
   `factorio-mod/README.md` for Linux/Mac).
3. **Configure RCON** in `%APPDATA%\Factorio\config\config.ini` (add if
   missing, not under any specific section):
   ```ini
   local-rcon-socket=127.0.0.1:34198
   local-rcon-password=factorio
   ```
   Or via the hidden settings GUI: Ctrl+Alt in the main menu → Settings →
   "The rest" tab → set `local-rcon-socket` / `local-rcon-password`.
4. **Start a multiplayer game:** Multiplayer → Host New Game (or Host Saved
   Game). RCON only works in multiplayer, even solo.
5. **Connect the MCP server:** `.mcp.json` in this repo tells Claude Code to
   run `bun run src/index.ts`; it starts automatically when needed.

## Player commands (in-game chat)

```
/fac <msg>         -- Chat to the orchestrator (companionId=0)
/fac <id> <msg>    -- Chat to a specific companion
/fac spawn [n]     -- Request a companion spawn
/fac list          -- List companions
/fac kill [id]     -- Kill companion(s)
```

## Development

```bash
bun test                              # unit tests (src/**/*.test.ts)
bun run scripts/validate-tools.ts     # MCP tools <-> Lua commands parity
```

Lefthook runs both on pre-commit.

## Agent workflow

For how the orchestrating agent should actually run companions (the reactive
loop pattern, MCP tool categories, gotchas like RCON idle-socket behavior and
mod hot-reload), see `CLAUDE.md` — that's the operational reference, kept in
sync with the code it documents.

## Credits

Inspired by [Factorio Learning Environment](https://github.com/JackHopkins/factorio-learning-environment)
patterns and best practices.
