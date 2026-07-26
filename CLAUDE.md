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
- `companion_*` - spawn, list, status, stop, position, inventory, health, disappear
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

**Update mod** (macOS — this machine; the upstream README's `/c/Users/lveil/...` Windows path does not exist here):
```bash
MODS=~/Library/Application\ Support/factorio/mods/ai-companion
cp -r factorio-mod/* "$MODS/"
diff -rq factorio-mod "$MODS"   # must print nothing
```
Then main menu → Host Saved Game (control-stage files reload; no app restart — see Gotchas).

**Always run that `diff` before any live test.** The deployed dir is the only code Factorio
actually executes, and it has silently held a *partial* sync (2026-07-24: `building.lua` at HEAD
while `queues.lua`/`init.lua`/`companion.lua` predated the fixes they were supposed to prove).
`info.json`'s version is not evidence — it read `0.13.3` alongside a current `description`.

## Gotchas

- **Reloading mod code:** control-stage files (`control.lua` + everything it requires) are re-read from disk on every save load — main menu → Host Saved Game is enough, no app restart. Only `data.lua` needs a full restart. A `version` bump in `info.json` does NOT help: the running app only re-reads it at startup, so `on_configuration_changed` never fires on a re-host. Any new `storage.*` field must therefore be nil-guarded at its use sites (`storage.x = storage.x or {}`), not just declared in `init_storage()`.
- **`/silent-command` runs in the level script context**, which has its own `storage` separate from the mod's — it cannot read or write `storage.companions`, `storage.companion_messages`, etc. `game`, surfaces and entities are reachable. Anything touching mod state must go through a `/fac_*` command.
- **RCON connection handling (fixed):** the client correlates responses by request id, keeps TCP keepalive on, and tears down + auto-reconnects on framing desync or 2 consecutive command timeouts — the old "idle connection silently drops later commands" failure mode is gone. Failures now surface as `{success: false}` responses; treat them as real errors, not as the historical idle-socket bug. Known remaining gap: a single logical response split across multiple packets with the *same* request id is still truncated.
- **Background skills report through logs and exit codes:** skill processes write stdout/stderr to `.fac-skills/<id>-<skill>-<ts>.log`, end with a `SKILL_RESULT {json}` line, and exit nonzero on failure. `companion_status` / `session_status` expose the last run's exit code and log path — check them (or Read the log) instead of inferring outcomes from chat.
- **Companions are controllerless characters:** they have `begin_crafting` / `get_craftable_count` (LuaControl) but NOT `can_craft` (LuaPlayer). Their crafting queue does run to completion unattended.
- **Reach limits are ALWAYS on (mod 0.15.0) and the engine reach properties read fine on a companion** — live-probed identical to the player's: `reach_distance`/`build_distance` 10, `resource_reach_distance` **2.7**, `item_pickup_distance` 1, `loot_pickup_distance` 2. `check_reach` (`init.lua`) is the single source of truth; there is no `companion_realistic` flag any more. Two traps: the refusal payload's `reach` field is `math.floor(limit + 0.5)`, so it displays **3** for the real 2.7 — never threshold against it. And `fac_resource_nearest` floors its coordinates, so up to ~1.4 tiles of rounding stacks on a 2.7-tile budget; walk to within ~1 tile, not 2.
- **Mining out of reach was always a silent no-op, never a hang.** Before 0.15.0 an out-of-range `resource_mine` was accepted (`{mining:true, entities:12}`), harvested nothing because the *engine* refuses past 2.7, and self-terminated in ~1s. Building out of reach, by contrast, genuinely worked — `create_entity` is not engine-bounded — so 0.15.0 removes a real capability there and only adds a structured error for mining.
- **Empty Lua tables serialise as `{}`, not `[]` — coerce at every parse boundary.** `helpers.table_to_json` has no array/object distinction, so any "list of things" response arrives as a JS *object* when empty and array methods on it throw. This shipped as a live bug: `combat_until` crashed with `TypeError: enemies.sort is not a function` whenever no enemies were in range, and `mine-until.ts` threw "is not iterable" on an empty inventory. Use `asArray<T>()` from `src/utils/connection.ts` **at the point the response is parsed**, once per boundary — not defensively at each use. Neither `bun test` nor the validator can catch this class.
- **Companions arm themselves at spawn by TAKING from the player, never by conjuring** (mod 0.14.0). `fac_companion_spawn` transfers a gun + ammo out of `game.players[1]`'s *main* inventory only, never their equipped slots, and returns `{armed:false, arm_reason}` when nothing suitable exists — an unarmed spawn is a success, not an error. `start_combat` re-equips from the companion's own inventory first (so a weapon handed over via chest or ground pickup gets used), then hard-fails `{error="No weapon equipped"}` / `{error="No ammo"}`. **Ammo compatibility must be matched via `prototypes.item[ammo].ammo_category.name` ∈ `prototypes.item[gun].attack_parameters.ammo_categories`** — `can_insert` returns true for a rocket with only an SMG equipped, and `get_ammo_type()` returns nil in 2.0. Companions now carry the player's real weapons, so `disappear` / `/fac kill` / `stop_all` spill the gun and ammo slots to the ground rather than destroying them.
- **`fac_companion_spawn` on a still-alive companion returns `{status:"exists"}` and skips spawn-time work entirely** — including arming. Remove it first (`fac_companion_disappear` clears `storage.companions[id]`) and assert `spawned === true`; a silent `exists` otherwise cascades into confusing downstream failures.
- **Combat kills are credited by `on_entity_died` attribution, not by inferring from target validity.** `event.cause` IS populated for character gun fire (verified live). `maxKills` is a stopping *floor*, not a mid-round cap: the Lua queue fights a round to target exhaustion and `combat-until` only re-checks between rounds, so 5 targets against `maxKills:4` legitimately yields 5 kills.
- **Companion crafting doesn't count for research:** `c.entity.begin_crafting{...}` on a companion produces the item but does NOT register in `force.get_item_production_statistics()` - verified live, dozens of companion-crafted items all read 0 input count. Factorio 2.0 `craft-item` trigger technologies (e.g. `automation-science-pack` fires on crafting 1 lab) read that same statistic, so a companion can never satisfy one by crafting alone. Fix: either produce the item from a machine (furnace/assembler, which does register), or use `item_craft`'s `credited=true` mode, which runs `game.players[1].begin_crafting{...}` instead - this registers correctly, at the cost of spending the human player's inventory and crafting queue.

## Troubleshooting

- **Connection refused:** Factorio not running in multiplayer mode
- **Unknown command:** Mod not loaded, restart Factorio
- **3+ ECONNREFUSED:** Factorio disconnected, kill reactive-all task and restart

## References

- FLE (inspiration): `../factorio-learning-environment/`
- Validation: `bun run scripts/validate-tools.ts` (52 tools = 52 Lua commands as of mod 0.15.0, which removed `companion_realistic`; also checks arity/argument order, not just names). CAVEAT: it covers the request side only — Lua *response shapes* and the hand-rolled command strings inside `src/skills/*.ts` are unchecked, and both have drifted before. Contract changes need a live in-game check, not just a green validator. The arity check also cannot catch an optional Lua parameter that NO tool exposes — `checkArity` only asserts the TS placeholder count falls within `[mandatory..total]`, so `fac_companion_inventory` declaring 1 of its 3 captures passes cleanly while its chest-inspection branch stays unreachable through MCP (T-023).
- Lua has no test harness here, but `luac -p factorio-mod/commands/*.lua` (mise-provided) is a free syntax gate — neither the validator nor `bun test` parses Lua at all.
- Lefthook runs validation + `bun test` on pre-commit
- Live smoke tests: `scripts/smoke/` — drives the real MCP server over stdio (`bun run src/index.ts`) with a second RCON connection as a side channel, one script per fix (`bun run scripts/smoke/t019-building-item-loss.ts`, …). **The combat suites construct a controlled arena rather than searching the live map**: they find a spot 80-160 tiles out verified clear of spawners and worms (worms are prototype `type="turret"`), teleport the companion in, and `create_entity` exactly the enemies needed, tracked by `unit_number` for exact teardown. Spawning items and teleporting is sanctioned **in harnesses only** — the mod's gameplay behaviour stays within player parity. Deliberately NOT named `*.test.ts`: lefthook runs `bun test` on pre-commit and these need a live hosted game. Note `src/mcp/server.ts` only exports the class — the entry point is `src/index.ts`, and it must be spawned with the repo root as cwd so relative skill paths, `.fac-skills/` and `.env` resolve.
