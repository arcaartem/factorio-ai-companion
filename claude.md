# Factorio AI Companion

AI companions for Factorio 2.x via MCP tools + RCON.

## Quick Start

**Reactive loop (manages ALL companions):**

1. `Bash(run_in_background: true): bun run src/reactive-all.ts`
2. `TaskOutput(task_id, block: true, timeout: 120000)`
3. Parse JSON: `[{companionId, player, message, tick}, ...]`
4. Use MCP tools to respond/act
5. Loop

**Example:**
```
User: /fac 1 mina hierro

Your response:
- chat_say(companionId: 1, message: "Voy a minar hierro")
- resource_mine_until(companionId: 1, resource: "iron-ore", quantity: 50)
```

## MCP Tools (src/mcp/tools.ts)

**ALWAYS use MCP tools** (type-safe, validated 1:1 with Lua).

Categories:
- `chat_*` - say, get
- `companion_*` - spawn, list, status, stop, position, inventory, health, disappear, realistic
- `move_*` - to, follow, stop
- `resource_*` - nearest, list, mine, mine_until (skill)
- `item_*` - pick, craft, recipes
- `building_*` - place, remove, info, rotate, fuel, fill, empty
- `action_*` - attack, flee, patrol, wololo
- `research_*` - get, set, progress
- `world_*` - scan, scan_enemies, nearest
- `context_*` - clear, check

**Spawn companions:**
```
companion_spawn(companionId: 1)
companion_spawn(companionId: 2)
```

**Key principle:** ONE orchestrator manages ALL companions (id=0,1,2,...). NO separate Task subagents.

## Player Commands (in-game)

```
/fac <msg>         -- Chat to orchestrator (companionId=0)
/fac <id> <msg>    -- Chat to companion
/fac spawn [n]     -- Request spawn
/fac list          -- List companions
/fac kill [id]     -- Kill companion(s)
```

## Setup

**Factorio config** (`%APPDATA%\Factorio\config\config.ini`):
```ini
local-rcon-socket=127.0.0.1:34198
local-rcon-password=factorio
```
(Should be in the file, not under a specific section)

**Run:** Multiplayer → Host New Game (RCON only works in multiplayer)

**Install mod:** Copy `factorio-mod/` → `%APPDATA%\Factorio\mods\ai-companion\`

**Update mod:**
```bash
# Windows command (use this, xcopy has path issues in bash)
cp -r /c/Users/lveil/Desktop/Projects/factorio-ai-companion/factorio-mod/* /c/Users/lveil/AppData/Roaming/Factorio/mods/ai-companion/
```
Restart Factorio.

## Gotchas

- **Reloading mod code:** control-stage files (`control.lua` + everything it requires) are re-read from disk on every save load — main menu → Host Saved Game is enough, no app restart. Only `data.lua` needs a full restart. A `version` bump in `info.json` does NOT help: the running app only re-reads it at startup, so `on_configuration_changed` never fires on a re-host. Any new `storage.*` field must therefore be nil-guarded at its use sites (`storage.x = storage.x or {}`), not just declared in `init_storage()`.
- **`/silent-command` runs in the level script context**, which has its own `storage` separate from the mod's — it cannot read or write `storage.companions`, `storage.companion_messages`, etc. `game`, surfaces and entities are reachable. Anything touching mod state must go through a `/fac_*` command.
- **RCON idle socket:** the client uses one socket with `socket.once("data")` and no request-ID correlation. Sleeping ~30s on an open connection makes every later command silently fail. Sleep *before* connecting; keep scripts short with fresh connections.
- **Companions are controllerless characters:** they have `begin_crafting` / `get_craftable_count` (LuaControl) but NOT `can_craft` (LuaPlayer). Their crafting queue does run to completion unattended.

## Troubleshooting

- **Connection refused:** Factorio not running in multiplayer mode
- **Unknown command:** Mod not loaded, restart Factorio
- **3+ ECONNREFUSED:** Factorio disconnected, kill reactive-all task and restart

## References

- FLE (inspiration): `../factorio-learning-environment/`
- Validation: `bun run scripts/validate-tools.ts` (53 tools = 53 Lua commands; also checks arity/argument order, not just names)
- Lefthook runs validation on pre-commit
