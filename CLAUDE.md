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

**Manual path** (only needed for interactive poking at a live game — `test-server.ts --client` now automates the combat suites too, see Gotchas; macOS — this machine, the upstream README's `/c/Users/lveil/...` Windows path does not exist here):
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

**Preferred loop — don't re-host at all: `bun run scripts/smoke/test-server.ts <suite>`, or
`--client <suite>` when the suite needs a live combat client.** The base form deploys
`factorio-mod/` (with the `diff -rq` gate), copies your newest save, starts a *disposable
headless server* on its own ports and its own `write-data` dir, runs the suite against it, and tears
everything down. A fresh process always reads the mod off disk, so this **is** the reload — and it
runs alongside the game you're playing without touching it, so the suites stop teleporting
companions and planting ore in your real world. It operates on a **copy** of your save, never the
original — this is why the loop can never serve work that must persist into the world you actually
play. With no client connected `game.players[1]` is valid but has **no character**, so companions
spawn *unarmed*: mining/movement/world suites are fine with that, the combat suites are not.
`--client` (mod 0.21.1 harness) closes that gap — it launches a real Factorio client attached to the
disposable server via `--mp-connect` and waits for `game.players[1]` to have a character before
running the suite, so the combat suites (t021, t026, t051) now automate too; see the Steam-build
trap in Gotchas before using it. Three Factorio roots are in play now, each needing its own
`write-data` and `--port`: the game you're playing, the disposable server, and — with `--client` —
the attached client; the script handles all three. Use `--serve`/`--keep` to hold the server up,
`--save <path>` to pin a world.

**Always run that `diff` before any live test.** The deployed dir is the only code Factorio
actually executes, and it has silently held a *partial* sync (2026-07-24: `building.lua` at HEAD
while `queues.lua`/`init.lua`/`companion.lua` predated the fixes they were supposed to prove).
`info.json`'s version is not evidence — it read `0.13.3` alongside a current `description`.

## Gotchas

- **Reloading mod code:** control-stage files (`control.lua` + everything it requires) are re-read from disk on every save load — main menu → Host Saved Game is enough, no app restart. Only `data.lua` needs a full restart. A `version` bump in `info.json` does NOT help: the running app only re-reads it at startup, so `on_configuration_changed` never fires on a re-host. Any new `storage.*` field must therefore be nil-guarded at its use sites (`storage.x = storage.x or {}`), not just declared in `init_storage()`.
- **A green smoke run says NOTHING about whether the mod can load — the harness is structurally
  blind to the data stage.** Every suite here drives control-stage commands, which can only run once
  the mod has already loaded, so a mod that fails at load produces no red assertions; it produces no
  run at all. Mod 0.20.0 shipped exactly that way: removing the wololo sound left `data.lua` calling
  `data:extend({})`, and `__core__/lualib/dataloader.lua:23` rejects an empty array with
  `Invalid array of prototypes`, failing the whole mod. **A data-stage file with nothing to declare
  must make no `extend` call at all** — an empty table is not a no-op. The failure surfaces only in
  the server log (`Failed to load mod "ai-companion"`) and only at *application* startup, so the
  cheapest gate is that `test-server.ts` reaches RCON-ready at all; if it never binds, read
  `.fac-test-server/server.log` before suspecting anything else.
- **`/silent-command` runs in the level script context**, which has its own `storage` separate from the mod's — it cannot read or write `storage.companions`, `storage.companion_messages`, etc. `game`, surfaces and entities are reachable. Anything touching mod state must go through a `/fac_*` command.
- **Tool arguments are NOT byte-verbatim through MCP — `buildRCONCommand` normalises whitespace.** `src/mcp/tools.ts` collapses every `\s+` run to a single space and trims, across the *whole* rendered command including argument values, so `chat_say("a  b")` arrives in game as `a b` and `"  x  "` as `x`. It exists to tidy slots that substituted to `""`, but it cannot tell a padding space from a payload one. Values are otherwise safe, for a reason worth knowing: the replacer is a **function**, and `String.replace` only interprets `$&`/`$$`/`` $` ``/`$1` when the replacement is a *string* — so `$` needs no escaping — and `/g` never re-scans inserted text, so a literal `{radius}` inside a value cannot be re-substituted. Both are pinned by `src/mcp/tools.test.ts`. Send over raw RCON when you need a payload preserved exactly; multi-space survives the Lua and transport halves untouched (verified live, `t013` A3/A4).
- **`fac_chat_say` leaves no record — the `said` echo is the only observable.** It just calls `game.print`; nothing lands in mod storage, `fac_chat_get` drains the *inbound* queue so it can never see an outbound say, `storage.errors` is write-only, and the interactive game's `factorio-current.log` carries no `game.print` output at all. Assert on the handler's returned `{id, name, said}`.
- **RCON connection handling (fixed):** the client correlates responses by request id, keeps TCP keepalive on, and tears down + auto-reconnects on framing desync or 2 consecutive command timeouts — the old "idle connection silently drops later commands" failure mode is gone. Failures now surface as `{success: false}` responses; treat them as real errors, not as the historical idle-socket bug. Known remaining gap: a single logical response split across multiple packets with the *same* request id is still truncated.
- **Undiagnosed, observed 2026-07-29: after a long session of many short-lived side-channel connections, NEW RCON connections start failing `Authentication failed - invalid password` while an already-established connection keeps working fine.** During T-003 roughly 25 `connectRCON()` scripts ran fine, then one failed and succeeded on an immediate retry, then failed permanently — while the MCP server's own long-lived connection continued serving `companion_*` calls throughout, and the game process and port 34198 were unchanged. So it is not a wrong password and not the game dying. The password is correct by construction (the same `.env` served the working calls minutes earlier). **This is an observation, not a diagnosis** — plausible causes not yet distinguished: a Factorio-side cap on concurrent or cumulative RCON sessions, or sockets not being reclaimed by the harness's `close()`. It matters because every smoke suite deliberately opens a side channel *alongside* the MCP server; if this is cumulative rather than concurrent, a long suite could hit it mid-run and present as an unrelated code failure. If a suite dies this way, restart the game before suspecting the code, and prefer one long-lived side-channel connection over many short ones.
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
- **Bound the ACTION, not the search that finds candidates for it — clamping the search to the
  reach limit silently kills your own diagnostics.** `fac_item_pick` (0.21.0) first shipped with
  its ground scan clamped to `loot_pickup_distance`, which looked like defence in depth and was
  really a bug: nothing past the limit ever entered the candidate set, so the
  `skipped_out_of_reach` counter could only ever count the sliver where the engine's
  *bounding-box* search overshoots the *circular* reach test, and it read **0** live. A caller
  asking `radius = 1000` learned nothing about items 5 tiles away — the exact "walk closer" vs
  "nothing here" distinction the field exists to provide. The search is now capped at a plain 50
  and the per-item `check_reach` is the only gate on picking. Same shape as the query exemption
  above: looking is not acting.
- **`stop_combat` clearing `shooting_state` BEFORE its `if not q then return` early exit was
  necessary but not sufficient (mod 0.21.0 → 0.21.1).** `fac_action_attack` sets `shooting_state`
  directly and creates no combat queue at all, so nothing in the mod could stop a companion it had
  set firing unless `stop_combat`'s own early return let the clear through first — 0.21.0 got that
  ordering right. But the *caller*, `fac_companion_stop_all`, still gated the call itself on
  `storage.combat_queues[id]`, a table `fac_action_attack` never populates — so the one caller that
  needed the fix could never reach it. The ordering was correct and unreachable; the bug had moved
  from the callee to the caller without changing symptom, and the previous version of this note
  warned against moving the clear back inside the queue branch without noticing that `stop_all`'s
  gate had, in effect, already done exactly that by never calling `stop_combat` for the queue-less
  path in the first place. 0.21.1 calls `queues.stop_combat` unconditionally from `stop_all` instead
  of gating it, and nil-guards `storage.combat_queues` inside `stop_combat` itself, since the
  removed gate had been providing that guard as an incidental side effect, not by design. The
  `stopped` list in the response still names `"combat"` only when a queue genuinely existed, so the
  response contract is unchanged. General lesson: a fix's correct internal ordering plus an
  accurate comment describing it is not evidence the intended caller actually reaches that code —
  check the call site, not just the callee.
- **`fac_action_attack` and the combat QUEUE are disjoint state.** `fac_action_attack` (`action.lua`)
  sets `shooting_state` directly, creates no `storage.combat_queues` entry, credits no kills, and
  writes nothing to `storage.combat_results` — so `fac_action_attack_status` can never reflect a
  synchronous `action_attack`; a poll after one reads the previous queued round's result, or zero.
  Also worth knowing: `fac_action_attack` has a deliberate **ground-fire fallback** — when nothing
  hostile resolves within radius 2 of the aim point it does not error, it returns
  `{attacking:true, target:"ground"}` and fires at the point. A test expecting a refusal there is
  wrong, not the mod: `u.resolve_target` returns `nil` plus an error table without emitting a
  response, which is what makes the fallback clean.
- **The combat paths were unverifiable headless — `--client` (harness change, not a mod change)
  fixes that.** Without a connected client `game.players[1]` has no character, so companions spawn
  UNARMED and 0.21.0's weapon/ammo gate short-circuits `fac_action_attack`, `start_combat`, the
  chase leash and `stop_all`'s shooting clear before any of them do anything — a green plain
  `test-server.ts` run said nothing about them. `test-server.ts --client` now attaches a real
  Factorio client via `--mp-connect` and waits for a character before running the suite, and `t051`
  ran all of this 59/59 across three consecutive runs. Arming the companion over the side channel
  to dodge the missing-character problem would still prove the harness, not the mod — that's why
  the fix is a real client rather than a shortcut; see Setup and the Steam-build trap below for
  what `--client` actually requires.
- **The client (`--client`) is a Steam binary, and Steam's own restart-guard blocks a bare
  `--mp-connect` launch.** Launched directly, it calls `SteamAPI_Init()`; with no `steam_appid.txt`
  in its cwd telling it its app id, it concludes it wasn't launched through Steam, calls
  `SteamAPI_RestartAppIfNecessary()`, and exits with "Steam requires game restart, restarting..."
  instead of connecting — Steam itself must already be running and logged in. A `steam_appid.txt`
  in the client's working directory skips the check. The headless `--start-server` path never
  initialises the Steam API at all, which is why this trap had never surfaced before `--client`
  existed. Separately, the client reuses the real `player-data.json`, so it authenticates as the
  same account the save already knows as `game.players[1]` — a fresh `write-data` has none and
  would join anonymously as a NEW player, leaving `players[1]` characterless while everything else
  appeared to work; that index matters because `fac_companion_spawn` arms specifically from
  `game.players[1]`. That file holds an auth token and must never be logged. And
  `~/Applications/factorio.app` is a Steam launcher STUB whose `run.sh` is a single
  `open steam://run/427520` — the real binary lives under the Steam library (this machine:
  `/Volumes/External Storage/MacosSteamLibrary/...`), which `findFactorioBinary()` already sweeps
  `/Volumes/*` for.
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
- **`find_entities_filtered`'s `limit` truncates in chunk order, with no distance ordering** — so "scan wide with a limit, then pick the minimum" returns *nearest of an arbitrary sample*. This was `resource_nearest`/`world_nearest` until 0.17.0 (±200 square, `limit = 100`): probed live, it was wrong for **all four** ore types at one position, worst case naming a patch at 106.95 while ore sat at 98.39 on the opposite side of the map. The fix idiom is `u.find_nearest` (`init.lua`) — an **unlimited** circular search grown 8→16→32→64→128→200, complete by construction because everything omitted is farther than the ring's own radius, and cheap because the near case stops at ring 1. Reach for that helper rather than adding another limited scan. `fac_resource_list` had the same shape (`limit = 20` then sort) until 0.21.0; it now pushes the filter into the engine query with no limit, sorts, then truncates to 20 in Lua. **Its wire argument order also changed to `{companionId} {radius} {filter}` in the same release** — an empty-defaulting `filter` sitting *before* an always-populated `radius` meant whitespace collapse bound radius's digits into the filter capture, so every call that omitted a filter (the most common form) returned `count: 0`, and an explicit `radius` was silently discarded. The general rule: **in an RCON template, an optional argument must never precede a defaulted one** — put the always-populated argument first and the shift is impossible by construction.
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
- **`rotatable` is not "can this be rotated" — `supports_direction` is. Live-probed across 34 base
  prototypes: `LuaEntity.rotatable` was `true` for every one**, wooden/iron/steel chest, lab, radar,
  every electric pole, pipe, gun turret, solar panel, accumulator and substation included. It is a
  per-instance "can the player press R on it" permission seeded from the `not-rotatable` entity
  flag, which base data sets on almost nothing (character corpses, crash-site wreckage).
  `prototypes.entity[n].supports_direction` is the property that actually discriminates — false for
  13 of those 34. So a predicate filtering on `e.rotatable` filters essentially nothing while
  reading like a gate, which is what it did in `building_rotate` until 0.20.2. Two further traps
  the same probe settled, both of which look like the other from the reply alone: `stone-furnace`
  has `supports_direction` **true**, so rotating one reaches the assign→read-back comparison and
  returns `"Rotate had no effect"` — *not* the `supports_direction` refusal, which is what a
  wooden-chest gets. And deriving either fact from base data or the forums gets it wrong; a code
  read predicted `stone-furnace` false and the engine said true.
- **`building_place` reports where the entity actually landed.** It used `create_entity`'s return
  value as a bare truthiness test, so a caller never learned the snapped centre (a 3x2 boiler
  requested at `(9.5, 32.5)` seats at `(9.5, 32)`) and had nothing but its own coordinates to hand
  to `remove` — that, not `remove` itself, was the real cause of place/inspect/remove loops
  stranding buildings and draining the inventory until placements failed `{"error":"Not in
  inventory"}`. `place` now returns the real `position`/`direction`, and the async path records the
  same in `storage.build_results` (reasons `placed`/`blocked`/`stopped`/`too_far`/`no_item`) because
  the build queue is pruned on the same tick `create_entity` runs — the same outcome-before-deletion
  rule the harvest and combat queues follow.
- **A deferred action must re-check its preconditions and DEBIT BEFORE it creates (mod 0.20.4).**
  `tick_build_queues` fires ~60-64 ticks after `start_build` and used to re-check *nothing* — it
  called `create_entity` first, then `remove_item`, discarding the return. So spending the item
  inside that window (a synchronous `building_place`, `building_fill`/`fuel`, `item_craft`) still
  produced the building with nothing debited: **two entities from one item**, violating the
  never-conjured invariant at `commands/init.lua:277-280`. The synchronous `fac_building_place` has
  the same create-then-remove order and is *sound anyway*, because all its steps run in one tick
  with nothing able to interleave — which is exactly why copying the sync path verbatim is the wrong
  fix, and why "checked once at queue time" is not a check at all. The queue now re-validates reach
  (`too_far`) and `can_place_entity` (`blocked`), then `inv.remove{count=1}` on
  `character_main` **with its return inspected** (`no_item`), and only then creates. Two details
  worth keeping: use `get_inventory(defines.inventory.character_main).remove` rather than
  `LuaControl::remove_item`, which is not restricted to the main inventory and can drain gun/ammo
  slots; and the `create_entity`-still-nil path must **refund** the debit, or the fix trades a
  conjure bug for a destroy bug. `t043` asserts item counts absolutely on that branch for that
  reason. Still open on the same code: `stop_all` drops the build queue without recording a result
  (T-049), and none of the `on_nth_tick` queue handlers is `pcall`-protected (T-050).
- **A smoke suite that only ever ADDS to the companion's inventory will report red against working
  code.** `t043`'s first live run failed its own conjure section because section 1 left 2 furnaces
  behind and section 2 added 1 rather than resetting: the queued build fired with items in hand and
  correctly answered `placed`, so the zero-item path under test was never created. The end-state
  arithmetic was perfectly conservative — 3 items in, 2 buildings + 1 held — which is the tell that
  the *harness* was wrong. Reset each section to an absolute count (`setCompanionItems`), assert the
  precondition exactly, and **return early when a setup assertion fails**: every DECISIVE assertion
  that ran on top of that broken premise reported a defect that did not exist.
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
- **Companion crafting doesn't count for research:** `c.entity.begin_crafting{...}` on a companion produces the item but does NOT register in `force.get_item_production_statistics()` - verified live, dozens of companion-crafted items all read 0 input count. Factorio 2.0 `craft-item` trigger technologies (e.g. `automation-science-pack` fires on crafting 1 lab) read that same statistic, so a companion can never satisfy one by crafting alone. Fix: either produce the item from a machine (furnace/assembler, which does register), or use `item_craft`'s `credited=true` mode, which runs `game.players[1].begin_crafting{...}` instead - this registers correctly, at the cost of spending the human player's inventory and crafting queue. **The trap is narrower than it looks, so check which kind of technology you have before reaching for `credited`:** it applies only to `craft-item` TRIGGER technologies. A unit-based tech (`research_unit_count` populated — `automation` is 10 units of 1 automation-science-pack) consumes packs from a lab and does not read production statistics at all, so plain companion crafting is fine (T-002, live).
- **`item_craft`'s `count` is the number of CRAFTS, not of output items, and the queue debits ingredients up front while delivering products one craft at a time.** `count` goes straight to `begin_crafting{count = count}`, so `transport-belt` at `count = 2` yields **4** belts. More importantly the call returns immediately with `{crafted = N}` — that is the number *queued*, not produced. An inventory read taken right after shows the ingredients already gone and the products still missing, which reads exactly like items vanishing; 10 science packs took ~4 minutes of real time to land. Poll `LuaControl.crafting_queue_size` down to 0 before asserting on the result, and craft bottom-up in dependency order — the mod gates on `get_craftable_count(recipe) < count`, so queueing a recipe whose intermediates are still in the queue is refused with `{error = "Missing"}`.
- **`research_set` APPENDS to the research queue — it does not preempt — and says `researching` either way.** `fac_research_set` calls `force.add_research(name)`, which puts the technology at the *end* of the queue, then replies `{researching = <name>}` unconditionally. With any research already in progress the named tech does not start: the incumbent keeps consuming science packs while the reply claims otherwise. This cost 8 of 10 hand-crafted packs to a 50-unit `steel-processing` in T-002 before `research_get` exposed it. Until **T-055** lands, always read `force.current_research` back over the side channel after calling it, and note the mod has **no** command to cancel or reorder the queue — `force.research_queue = {"<name>"}` over `/silent-command` is the only lever, and it is player-parity-legal because clicking a technology in the GUI does exactly that.
  **Narrowed 2026-07-29 (T-003): appending is CORRECT when the queue is empty, and repeated calls are a usable queue-builder — so do not "fix" this by making `research_set` always preempt.** With `current_research == nil` and an empty queue, six consecutive calls (`lamp`, `military`, `gun-turret`, `stone-wall`, `radar`, `repair-pack`) produced exactly that order, verified behaviourally rather than from the replies: `lamp` completed unaided, `military` became current, and `lamp` dropped out of `research_get`'s `available` list (8 → 7). Preempting unconditionally would destroy that ordering property and make a queue unbuildable through the tool. The defect is only the **reply** — all six answered `{researching: <name>}` while five were merely queued — so a `queued` vs `researching` distinction is the right fix and preemption, if wanted, belongs in a separate command. Related gap found the same day: **`research_get` returns `current` + `available` but NOT the queue**, so a multi-call sequence cannot be confirmed through the tool surface at all.
- **`drop_target` is resolved when the entity is created and is NOT recomputed when a neighbour appears later — so place the consumer before the producer.** A burner drill placed *before* its stone furnace read `drop_target = "GROUND"` afterwards, and its drop position `(-74.703,-68.5)` sits 0.004 tiles outside the furnace's bounding box, which together look like decisive proof of a broken layout. Both signals are red herrings: the known-good pair 4 tiles away has the *same* 0.004 boundary quirk and reports correctly, and by TILE logic (`math.floor` of the drop position, not the float against the box) the drop lands squarely inside the furnace footprint. Fuelling both produced 4 plates within seconds and `drop_target` then read `stone-furnace`. This is the mechanism behind the design doc's long-standing "`drop_target` reported GROUND for a pair that was demonstrably feeding itself" warning. Build furnace-then-drill, and if you cannot, settle it by fuelling and watching the target's output rather than by re-reading the property.
- **Never validate a fuel feeder against a hand-filled target — an inserter tops a burner's fuel slot only to ~5.** A chest + burner-inserter feeding the lake boiler was checked against a boiler hand-filled to 50, and correctly never fired: for 11 straight minutes the boiler drained 43 → 16, the chest sat unchanged at 299, and the inserter reported `waiting_for_space_in_destination` — indistinguishable from a mis-built feeder. The tell was that `boiler.can_insert{name="coal"}` returned **true** on the same tick the inserter claimed no space; the status is about the inserter's own top-up threshold, not the boiler's capacity. Draining the boiler to 5 made the chest decrement immediately. Fill the target to zero and let the feeder establish its own level. Same family as `can_place_entity` and `drop_target`: the engine property answered a narrower question than the one being asked.

## Troubleshooting

- **Connection refused:** Factorio not running in multiplayer mode
- **Unknown command:** Mod not loaded, restart Factorio
- **3+ ECONNREFUSED:** Factorio disconnected, kill reactive-all task and restart

## References

- FLE (inspiration): `../factorio-learning-environment/`
- Validation: `bun run scripts/validate-tools.ts` (**51 tools = 51 Lua commands as of mod 0.20.0**, which removed `action_wololo`; 0.15.0 removed `companion_realistic`; also checks arity/argument order, not just names). CAVEAT: it covers the request side only — Lua *response shapes* and the hand-rolled command strings inside `src/skills/*.ts` are unchecked, and both have drifted before. Contract changes need a live in-game check, not just a green validator. **`checkArity` now also flags an optional Lua capture that NO tool exposes (added 0.21.0)** — it used to assert only that the TS placeholder count fell within `[mandatory..total]`, so `fac_companion_inventory` declaring 1 of its 3 captures passed cleanly while its chest-inspection branch stayed unreachable through MCP. That check lit up 4 tools / 5 captures, all now exposed (`companion_inventory` x/y, `companion_health` target, `item_recipes` filter, `research_progress` technology), and it is a hard error — so adding a Lua capture without a TS param fails the pre-commit gate. The mirror-image defect is still invisible: `validate-tools.ts` skips the 17 commands with no `parse_args` at all, which is how `TOOLS.help` gets away with templating a `{category}` that `help.lua` never accepts.
- Lua has no test harness here, but `luac -p factorio-mod/commands/*.lua` (mise-provided) is a free syntax gate — neither the validator nor `bun test` parses Lua at all.
- Lefthook runs validation + `bun test` on pre-commit
- Live smoke tests: `scripts/smoke/` — drives the real MCP server over stdio (`bun run src/index.ts`) with a second RCON connection as a side channel, one script per fix (`bun run scripts/smoke/t019-building-item-loss.ts`, …). **The combat suites construct a controlled arena rather than searching the live map**: they find a spot 80-160 tiles out verified clear of spawners and worms (worms are prototype `type="turret"`), teleport the companion in, and `create_entity` exactly the enemies needed, tracked by `unit_number` for exact teardown. **`unit_number` is nil on resource entities** (and simple entities generally), so an ore arena must key teardown on the exact recorded position instead — tracking ore by id silently no-ops and leaves every planted tile in the live world (bit `t031` for 4 runs; verify world cleanliness independently, since a no-op teardown logs nothing). Spawning items and teleporting is sanctioned **in harnesses only** — the mod's gameplay behaviour stays within player parity. Deliberately NOT named `*.test.ts`: lefthook runs `bun test` on pre-commit and these need a live hosted game. Note `src/mcp/server.ts` only exports the class — the entry point is `src/index.ts`, and it must be spawned with the repo root as cwd so relative skill paths, `.fac-skills/` and `.env` resolve. **The MCP SDK does not pass the parent environment to the server it spawns** — it substitutes a sanitized default — so `lib.ts`'s `connectMCP` merges `process.env` in explicitly. Without that merge a suite's MCP half falls back to the repo `.env` while its side-channel RCON honours the caller's `FACTORIO_*` overrides, and the two halves silently drive **different Factorio instances**; it presents as a code failure (t034's banner reported stale mod code that a direct RCON probe had just shown fresh). Prefer `test-server.ts` (see Setup) over running a suite by hand — it sets that env correctly and gives you a fresh mod load for free. **Assume a red run is the harness until you have ruled it out** — every suite here has produced at least one failure that was the test, not the code (t013's only red assertion matched Lua's error text in the wrong word order: the real phrasing puts `(a nil value)` *after* the variable name, as `attempt to index local 'player' (a nil value)`). Two spill-related traps for new suites: `u.spill_equipment` spills with `enable_looted = true`, so any character within `loot_pickup_distance` 2 — including a freshly respawned companion in a later section — silently vacuums the items back up and inflates a nearby harvest counter; and spilled stacks split across several `item-entity` entities, so compare **summed counts per name**, never entity counts. `scripts/smoke/t051-combat-parity.ts` is the newest of these — the combat-parity suite, driven via `test-server.ts --client`, 59/59 across three consecutive runs. Its first live run put a new shape on "assume a red run is the harness until you have ruled it out": the 4 reds were the harness, but not a broken assertion — section 5's leash test walks the companion ~30 tiles by design, and sections 6/7 had anchored on a stale arena constant, so a section that PASSED had invalidated a LATER section's preconditions, rather than a setup bug shadowing a real defect.
