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
- `action_*` - attack, flee, patrol
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

**Update mod + verify — the normal loop is one command, with no human step:**
```bash
bun run scripts/smoke/test-server.ts t034      # deploy, fresh server, run suite, tear down
```
See "Preferred loop" below for what it does and its one limitation.

**Manual path** (needed only for the combat suites, which require a connected client; macOS — this machine, the upstream README's `/c/Users/lveil/...` Windows path does not exist here):
```bash
MODS=~/Library/Application\ Support/factorio/mods/ai-companion
cp -r factorio-mod/* "$MODS/"
diff -rq factorio-mod "$MODS"   # must print nothing
```
Then main menu → Host Saved Game (control-stage files reload; no app restart — see Gotchas).

**No in-game reload exists — `game.reload_script()`, `game.reload_mods()` and `/fac_version` are all
dead ends.** Both reload calls are reachable from `/silent-command` over RCON and both return
success while changing nothing in a hosted multiplayer game (each verified 2026-07-26
behaviourally, not from the reply). `/fac_version` reads `script.active_mods`, pinned at
*application* startup — it reported `0.13.7` while 0.16.0 code ran. The only trustworthy evidence is
`diff -rq` plus a behavioural probe of something the new code changes.

**Preferred loop — don't re-host at all: `bun run scripts/smoke/test-server.ts <suite>`.** It
deploys `factorio-mod/` (with the `diff -rq` gate), copies your newest save, starts a *disposable
headless server* on its own ports and its own `write-data` dir, runs the suite against it, and tears
everything down. A fresh process always reads the mod off disk, so this **is** the reload — and it
runs alongside the game you're playing without touching it, so the suites stop teleporting
companions and planting ore in your real world. Two things to know: a second Factorio process needs
its own `write-data` (the first holds an exclusive lock on the user dir) and its own `--port`, both
of which the script handles; and with no client connected `game.players[1]` is valid but has **no
character**, so companions spawn *unarmed* — mining/movement/world suites are fine, the combat
suites (t021, t026) still need your interactive game. Use `--serve`/`--keep` to hold the server up,
`--save <path>` to pin a world.

**Always run that `diff` before any live test.** The deployed dir is the only code Factorio
actually executes, and it has silently held a *partial* sync (2026-07-24: `building.lua` at HEAD
while `queues.lua`/`init.lua`/`companion.lua` predated the fixes they were supposed to prove).
`info.json`'s version is not evidence — it read `0.13.3` alongside a current `description`.

## Gotchas

- **Reloading mod code:** control-stage files (`control.lua` + everything it requires) are re-read from disk on every save load — main menu → Host Saved Game is enough, no app restart. Only `data.lua` needs a full restart. A `version` bump in `info.json` does NOT help: the running app only re-reads it at startup, so `on_configuration_changed` never fires on a re-host. Any new `storage.*` field must therefore be nil-guarded at its use sites (`storage.x = storage.x or {}`), not just declared in `init_storage()`.
- **`/silent-command` runs in the level script context**, which has its own `storage` separate from the mod's — it cannot read or write `storage.companions`, `storage.companion_messages`, etc. `game`, surfaces and entities are reachable. Anything touching mod state must go through a `/fac_*` command.
- **Tool arguments are NOT byte-verbatim through MCP — `buildRCONCommand` normalises whitespace.** `src/mcp/tools.ts` collapses every `\s+` run to a single space and trims, across the *whole* rendered command including argument values, so `chat_say("a  b")` arrives in game as `a b` and `"  x  "` as `x`. It exists to tidy slots that substituted to `""`, but it cannot tell a padding space from a payload one. Values are otherwise safe, for a reason worth knowing: the replacer is a **function**, and `String.replace` only interprets `$&`/`$$`/`` $` ``/`$1` when the replacement is a *string* — so `$` needs no escaping — and `/g` never re-scans inserted text, so a literal `{radius}` inside a value cannot be re-substituted. Both are pinned by `src/mcp/tools.test.ts`. Send over raw RCON when you need a payload preserved exactly; multi-space survives the Lua and transport halves untouched (verified live, `t013` A3/A4).
- **`fac_chat_say` leaves no record — the `said` echo is the only observable.** It just calls `game.print`; nothing lands in mod storage, `fac_chat_get` drains the *inbound* queue so it can never see an outbound say, `storage.errors` is write-only, and the interactive game's `factorio-current.log` carries no `game.print` output at all. Assert on the handler's returned `{id, name, said}`.
- **RCON connection handling (fixed):** the client correlates responses by request id, keeps TCP keepalive on, and tears down + auto-reconnects on framing desync or 2 consecutive command timeouts — the old "idle connection silently drops later commands" failure mode is gone. Failures now surface as `{success: false}` responses; treat them as real errors, not as the historical idle-socket bug. Known remaining gap: a single logical response split across multiple packets with the *same* request id is still truncated.
- **Background skills report through logs and exit codes:** skill processes write stdout/stderr to `.fac-skills/<id>-<skill>-<ts>.log`, end with a `SKILL_RESULT {json}` line, and exit nonzero on failure. `companion_status` / `session_status` expose the last run's exit code and log path — check them (or Read the log) instead of inferring outcomes from chat.
- **Companions are controllerless characters:** they have `begin_crafting` / `get_craftable_count` (LuaControl) but NOT `can_craft` (LuaPlayer). Their crafting queue does run to completion unattended.
- **Reach limits are ALWAYS on (mod 0.15.0) and the engine reach properties read fine on a companion** — live-probed identical to the player's: `reach_distance`/`build_distance` 10, `resource_reach_distance` **2.7**, `item_pickup_distance` 1, `loot_pickup_distance` 2. `check_reach` (`init.lua`) is the single source of truth; there is no `companion_realistic` flag any more. One trap remains: the refusal payload's `reach` field is `math.floor(limit + 0.5)`, so it displays **3** for the real 2.7 — never threshold against it. (`fac_resource_nearest` used to floor its coordinates too, spending ~0.71 tiles of that 2.7-tile budget before you moved; fixed in 0.17.0, it now returns the entity's exact tile-centre position.)
- **Reach binds ACTIONS, not QUERIES — read-only, companion-centred queries are deliberately
  unbounded.** `world_scan`, `world_enemies`, `resource_list`, `resource_nearest`, `world_nearest`,
  `companion_position`, `companion_health` and `building_info` all read at arbitrary range on
  purpose: looking at something is not acting on it, the player has map view and a minimap, and
  binding them would mostly force pointless walking before every decision. Two rules follow when
  you add a query. First, say so explicitly rather than by omission — `building_info` passes
  `reach = false` to `u.resolve_target` at its call site, which is why the exemption survives an
  audit; a query that simply never calls `check_reach` reads as a bug. Second, **the exemption is
  for the RANGE only, not for the other resolution guarantees** — a read-only command must still
  resolve nearest-not-`es[1]` and still exclude characters, because `defines.inventory.chest ==
  character_main` means an unfiltered container read reports the *player's* inventory as "the
  chest". Anything that mutates the world stays bound, no exceptions.
- **A capability that cannot be bounded to player parity is REMOVED, not reach-limited (mod
  0.20.0).** `action_wololo` converted an enemy — including a nest, permanently and for free — at
  radius 25. There is no player action that converts an enemy at *any* distance, so no radius makes
  it parity-legal; bounding it would only have produced a cheat you have to stand next to. It is
  gone: command, MCP tool, help entry and sound prototype (the orphaned `sounds/wololo.ogg` is left
  on disk, since this repo is a fork with a live `upstream`). The tool surface is now **51 = 51**.
- **Mining out of reach was always a silent no-op, never a hang.** Before 0.15.0 an out-of-range `resource_mine` was accepted (`{mining:true, entities:12}`), harvested nothing because the *engine* refuses past 2.7, and self-terminated in ~1s. Building out of reach, by contrast, genuinely worked — `create_entity` is not engine-bounded — so 0.15.0 removes a real capability there and only adds a structured error for mining.
- **A character whose `mining_state.mining` is true CANNOT walk — the engine reverts `walking_state` every tick** (mod 0.16.0 / T-031). Live-probed: `tick_walk_queues` runs last and wrote `walking = true` on every tick, yet the engine read back `walking = false` in 20/20 samples with **0.000 tiles** moved; the same walk with no harvest queue covered 14.1 tiles in ~2s. Clearing `mining_state` un-pins it within 2 ticks and the standing walk queue resumes unaided. So mining and moving are mutually exclusive: `tick_harvest_queues` **yields** — clears `mining_state`, keeps the queue, re-asserts on the same entity afterwards — whenever a walk or combat queue is actively moving the companion. It deliberately does **not** yield to a walk queue latched at `no_path`/`stuck`, which would swap one permanent deadlock for another. This is invisible from the code: it reads exactly like a tick-ordering bug, so settle it by reading the engine's own state back off the character, not by reasoning about `queues.lua`.
- **`mining_state.mining` never goes false while the ore tile still has ore**, so any "mining stopped → count it" guard is dead code. A resource entity decrements `amount` (hundreds of ore per tile) rather than being consumed per ore; probed true in 20/20 samples over 10s while 5 ore were produced. This is what pinned `harvested` at 0 for four releases. Count a real main-inventory delta **every tick**, resetting the snapshot each time (or you double-count); advance to the next tile on `q.current.entity.valid` going false, not on `mining_state`. There is no `on_player_mined_entity` handler and adding one would not help — a controllerless character raises no player-mined events.
- **A finished queue's outcome must be recorded before the queue is deleted.** `resource_mine_status` returns `{active=false, harvested, target, reason}` from `storage.harvest_results` (reasons: `target_reached` / `too_far` / `pool_empty` / `stalled` / `stopped`), because the queue vanishes on the same tick its final ore is counted — a terminal poll otherwise has no way to read the result at all. Same shape as `storage.combat_results`. Before this, `mine-until`'s *success* path returned 0 even with counting fixed.
- **`find_entities_filtered`'s `limit` truncates in chunk order, with no distance ordering** — so "scan wide with a limit, then pick the minimum" returns *nearest of an arbitrary sample*. This was `resource_nearest`/`world_nearest` until 0.17.0 (±200 square, `limit = 100`): probed live, it was wrong for **all four** ore types at one position, worst case naming a patch at 106.95 while ore sat at 98.39 on the opposite side of the map. The fix idiom is `u.find_nearest` (`init.lua`) — an **unlimited** circular search grown 8→16→32→64→128→200, complete by construction because everything omitted is farther than the ring's own radius, and cheap because the near case stops at ring 1. Reach for that helper rather than adding another limited scan. `fac_resource_list` still has the same shape (`limit = 20` then sort) and is untouched — it's on T-015.
- **Fluid connections mate on BOTH halves, from the right fluidbox — and the offsets are already
  in the prototype.** Two fluidboxes connect when A's connection *position* equals B's *target*
  **and** B's position equals A's target; checking only the target half accepts two connections
  aimed *past* each other, which look like a match and never move fluid. The matching connection
  must also come from the intended box — a boiler has box 1 water (`production_type = "input"`,
  `flow_direction = "input-output"`) and box 2 steam (`"output"`), and a boiler whose *steam*
  output mates the pump is geometrically valid, physically backwards, and sits at `no_fuel`
  forever. Don't search for a placement: `prototypes.entity[n].fluidbox_prototypes[i]
  .pipe_connections[k].positions` is an array of **one offset per direction** (1=N, 2=E, 3=S,
  4=W), so the placement is computable. Dumping only `positions[1]` — the obvious thing — hides
  the direction relationship entirely and makes the offsets look constant. Parity matters too: an
  entity of ODD tile extent centres on a tile centre (`x.5`), EVEN on a tile boundary (integer),
  and the parities swap for E/W facings, so a wrong-parity candidate grid produces silently
  illegal placements that read as "no position works". Working chain (T-001): pump `(9.5,33.5)`
  facing S → output `(9.5,32.5)`; boiler `(10,31.5)` facing E, water conn offset `(-0.5,+1)`;
  engine `(13.5,31.5)` facing E, input conn offset `(-2,0)`.
- **`can_place_entity` is not a validity oracle for the offshore pump** — it returned `true` on a
  dry `sand-2` tile with **no water within 6 tiles**, in all four directions. Derive shoreline from
  `get_tile` adjacency instead. The pump's output is one tile in its facing direction and
  `direction` fully controls it, so a shore whose output tile is water just needs the pump turned;
  `building_place`'s direction argument is the lever, and passing `0` to every call (as the T-001
  probes initially did) makes the output look fixed.
- **Every coordinate-addressed building command resolves through `u.resolve_target` (mod 0.19.0) —
  route new ones through it too.** All six used to pick `es[1]` out of `find_entities_filtered`,
  which is the engine's **chunk order, not distance order**, so they acted on an arbitrary nearby
  entity and never said which: fuelling a furnace put coal in a drill 2.5 tiles away. The helper
  (`commands/init.lua`) takes `{name, type, force, radius, predicate, not_found, reach,
  reach_kind, allow_characters}`, picks the **nearest** survivor, excludes `type == "character"` by
  default, and checks reach against the **resolved entity** — `fill`/`empty` used to check the
  *requested point*, giving them effective reach 13 and 15 against a limit of 10. Every success
  payload now carries the `entity` and `position` actually acted on; use those rather than assuming
  your request was honoured. Two behaviour changes came with it: `fill`/`empty` act on ONE entity
  instead of fanning out across every match until the count is satisfied, and `fill` is restricted
  to the companion's own force, so neutral wreckage can no longer be filled (`empty` still reads it).
- **`defines.inventory` constants ALIAS to the same integers** — live-probed: `chest`,
  `character_main` and `fuel` are all **1**; `furnace_result` and `assembling_machine_output` are
  both **3**. Two traps follow. A "list of inventories to try" like `{chest, furnace_result,
  assembling_machine_output}` is really `{1, 3, 3}` and visits index 3 twice — which is what made
  `building_empty` reply `{error="count must be positive"}` while successfully extracting all 45
  plates (the second visit computed `want = 0` and `insert{count = 0}` *raises*, after the items
  moved). De-dup through a `seen` set. And because `chest == character_main`, a container search
  filtered only by force will drain the player's or another companion's inventory — filter by type
  or exclude characters. Note the engine's message points at the argument, not the loop, which is
  why T-040's card blamed argument parsing for four months; the same `count <= 0` trap also lived
  unreported in `building_fill` (`0` is truthy in Lua, so it survives `tonumber(...) or 10`).
- **`building_rotate` verifies rather than asserts (mod 0.19.0).** It used to return
  `{rotated, direction}` unconditionally with `direction` being the *requested* argument, so the
  reply could be true about a different entity than you meant. It now validates the index to 0-3
  (`u.dir_map[7]` was nil and silently became north while echoing back `7`), pre-checks
  `prototypes.entity[n].supports_direction`, then assigns, reads back and compares — erroring
  `"Rotate had no effect"` on mismatch. Its `direction` is now the raw `defines.direction` read off
  the entity, so it finally agrees with `building_info`; they previously disagreed on units (south
  was `2` from rotate, `8` from info). `LuaEntity.rotatable` exists; `LuaEntityPrototype` has no
  such key.
- **`building_place` reports where the entity actually landed.** It used `create_entity`'s return
  value as a bare truthiness test, so a caller never learned the snapped centre (a 3x2 boiler
  requested at `(9.5, 32.5)` seats at `(9.5, 32)`) and had nothing but its own coordinates to hand
  to `remove` — that, not `remove` itself, was the real cause of place/inspect/remove loops
  stranding buildings and draining the inventory until placements failed `{"error":"Not in
  inventory"}`. `place` now returns the real `position`/`direction`, and the async path records the
  same in `storage.build_results` (reasons `placed`/`blocked`/`stopped`) because the build queue is
  pruned on the same tick `create_entity` runs — the same outcome-before-deletion rule the harvest
  and combat queues follow.
- **Wood is selected by TYPE, not name (mod 0.18.0).** Trees ship dozens of prototypes (`tree-01`
  … `dead-dry-hairy-tree`), so `{name = "wood"}` matches nothing — asking for wood before 0.18.0
  returned `{error = "No resource"}` because `fac_resource_mine` and `queues.start_harvest` both
  seeded their pool with `{type = "resource"}`. `u.resource_filter` (`init.lua`) is now the single
  place that split lives; `resource_nearest`, `world_nearest` and `start_harvest` all route through
  it, so route any new call site through it too rather than re-deriving the mapping. Two things
  that follow: `amount` is a **resource-only** LuaEntity property and *raises* on a tree, so
  `resource_nearest` omits it for wood; and an unknown token yields a descriptive
  `{error = "Unknown entity name: …"}` (find_entities_filtered raising, caught by `safe_command`)
  rather than `"Not found"`, which is reserved for a valid prototype with none in range.
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
- Validation: `bun run scripts/validate-tools.ts` (52 tools = 52 Lua commands as of mod 0.16.0; the count last moved at 0.15.0, which removed `companion_realistic`; also checks arity/argument order, not just names). CAVEAT: it covers the request side only — Lua *response shapes* and the hand-rolled command strings inside `src/skills/*.ts` are unchecked, and both have drifted before. Contract changes need a live in-game check, not just a green validator. The arity check also cannot catch an optional Lua parameter that NO tool exposes — `checkArity` only asserts the TS placeholder count falls within `[mandatory..total]`, so `fac_companion_inventory` declaring 1 of its 3 captures passes cleanly while its chest-inspection branch stays unreachable through MCP (T-023).
- Lua has no test harness here, but `luac -p factorio-mod/commands/*.lua` (mise-provided) is a free syntax gate — neither the validator nor `bun test` parses Lua at all.
- Lefthook runs validation + `bun test` on pre-commit
- Live smoke tests: `scripts/smoke/` — drives the real MCP server over stdio (`bun run src/index.ts`) with a second RCON connection as a side channel, one script per fix (`bun run scripts/smoke/t019-building-item-loss.ts`, …). **The combat suites construct a controlled arena rather than searching the live map**: they find a spot 80-160 tiles out verified clear of spawners and worms (worms are prototype `type="turret"`), teleport the companion in, and `create_entity` exactly the enemies needed, tracked by `unit_number` for exact teardown. **`unit_number` is nil on resource entities** (and simple entities generally), so an ore arena must key teardown on the exact recorded position instead — tracking ore by id silently no-ops and leaves every planted tile in the live world (bit `t031` for 4 runs; verify world cleanliness independently, since a no-op teardown logs nothing). Spawning items and teleporting is sanctioned **in harnesses only** — the mod's gameplay behaviour stays within player parity. Deliberately NOT named `*.test.ts`: lefthook runs `bun test` on pre-commit and these need a live hosted game. Note `src/mcp/server.ts` only exports the class — the entry point is `src/index.ts`, and it must be spawned with the repo root as cwd so relative skill paths, `.fac-skills/` and `.env` resolve. **The MCP SDK does not pass the parent environment to the server it spawns** — it substitutes a sanitized default — so `lib.ts`'s `connectMCP` merges `process.env` in explicitly. Without that merge a suite's MCP half falls back to the repo `.env` while its side-channel RCON honours the caller's `FACTORIO_*` overrides, and the two halves silently drive **different Factorio instances**; it presents as a code failure (t034's banner reported stale mod code that a direct RCON probe had just shown fresh). Prefer `test-server.ts` (see Setup) over running a suite by hand — it sets that env correctly and gives you a fresh mod load for free. **Assume a red run is the harness until you have ruled it out** — every suite here has produced at least one failure that was the test, not the code (t013's only red assertion matched Lua's error text in the wrong word order: the real phrasing puts `(a nil value)` *after* the variable name, as `attempt to index local 'player' (a nil value)`). Two spill-related traps for new suites: `u.spill_equipment` spills with `enable_looted = true`, so any character within `loot_pickup_distance` 2 — including a freshly respawned companion in a later section — silently vacuums the items back up and inflates a nearby harvest counter; and spilled stacks split across several `item-entity` entities, so compare **summed counts per name**, never entity counts.
