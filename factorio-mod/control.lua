-- AI Companion - Factorio 2.x
local u = require("commands.init")
local queues = require("commands.queues")

-- Get version dynamically from mod info
local MOD_VERSION = script.active_mods["ai-companion"] or "unknown"

local function init_storage()
  storage.companion_messages = storage.companion_messages or {}
  storage.companions = storage.companions or {}
  storage.companion_next_id = storage.companion_next_id or 1
  storage.walking_queues = storage.walking_queues or {}
  storage.path_requests = storage.path_requests or {}
  storage.context_clear_requests = storage.context_clear_requests or {}
  storage.errors = storage.errors or {}
  storage.companion_markers = storage.companion_markers or {}
  queues.init()
end

local function cleanup_messages()
  local new_msgs, now = {}, game.tick
  for _, m in ipairs(storage.companion_messages) do
    if not m.read or (now - m.tick) < 18000 then new_msgs[#new_msgs + 1] = m end
  end
  if #new_msgs > 100 then
    local trimmed = {}
    for i = #new_msgs - 99, #new_msgs do trimmed[#trimmed + 1] = new_msgs[i] end
    new_msgs = trimmed
  end
  storage.companion_messages = new_msgs
end

script.on_init(function()
  init_storage()
  game.print("[AI Companion] v" .. MOD_VERSION .. " ready. /fac for help", u.print_color(u.COLORS.system))
end)

script.on_configuration_changed(function()
  init_storage()
  game.print("[AI Companion] Updated to v" .. MOD_VERSION, u.print_color(u.COLORS.system))
end)

local subcommands = {}

subcommands.spawn = function(player, args)
  local count = math.min(tonumber(args) or 1, 10)
  table.insert(storage.companion_messages, {player = player.name, message = "spawn " .. count, tick = game.tick, read = false, spawn_request = count})
  game.print("[" .. player.name .. "] Spawn " .. count .. " companion(s)...", u.print_color(u.COLORS.player))
end

subcommands.list = function(player)
  local count = 0
  for id, c in pairs(storage.companions) do
    if c.entity and c.entity.valid then
      local p = c.entity.position
      game.print(string.format("[#%d] (%.1f, %.1f)", id, p.x, p.y), u.print_color(c.color or u.get_companion_color(id)))
      count = count + 1
    else storage.companions[id] = nil end
  end
  if count == 0 then game.print("[AI Companion] No companions. /fac spawn", u.print_color(u.COLORS.system)) end
end

subcommands.kill = function(player, args)
  local id, killed = tonumber(args), 0
  local function kill_one(cid)
    local c = storage.companions[cid]
    if c then
      if c.label and c.label.valid then c.label.destroy() end
      -- Remove map marker
      if storage.companion_markers and storage.companion_markers[cid] then
        if storage.companion_markers[cid].valid then storage.companion_markers[cid].destroy() end
        storage.companion_markers[cid] = nil
      end
      if c.entity and c.entity.valid then
        -- Companions carry the player's real gun/ammo/items now (see arm_from) - spill
        -- them before destroying the entity, rather than destroying them outright.
        u.spill_inventory(c.entity, defines.inventory.character_main)
        u.spill_equipment(c.entity)
        c.entity.destroy()
        killed = killed + 1
      end
      storage.companions[cid] = nil
    end
  end
  if id then kill_one(id) else for cid in pairs(storage.companions) do kill_one(cid) end end
  game.print("[AI Companion] Killed " .. killed, u.print_color(u.COLORS.system))
end

subcommands.clear = function()
  local count = #storage.companion_messages
  storage.companion_messages = {}
  game.print("[AI Companion] Cleared " .. count .. " msg(s)", u.print_color(u.COLORS.system))
end

subcommands.name = function(player, args)
  local id_str, name = args:match("^(%d+)%s+(.+)$")
  local id = tonumber(id_str)
  if not id or not name then player.print("/fac name <id> <name>", u.print_color(u.COLORS.system)); return end
  local c = u.get_companion(id)
  if not c then player.print("#" .. id .. " not found", u.print_color(u.COLORS.error)); return end
  c.name = name
  if c.label and c.label.valid then c.label.destroy() end
  local color = c.color or u.get_companion_color(id)
  c.label = u.render_label(c.entity, name .. "(#" .. id .. ")", color)
  game.print("#" .. id .. " -> " .. name, u.print_color(color))
end

local function handle_fac(cmd)
  local ok, err = pcall(function()
    local player = cmd.player_index and game.players[cmd.player_index]
    if cmd.player_index and (not player or not player.valid) then return end
    local param = cmd.parameter
    if not param or param == "" then
      if player then player.print("/fac <msg> | <id> <msg> | spawn | list | kill | clear | name", u.print_color(u.COLORS.system)) end
      return
    end
    local first, rest = param:match("^(%S+)%s+(.+)$")
    if first and rest and not subcommands[first] then
      local id, comp = u.find_companion(first)
      if id then
        table.insert(storage.companion_messages, {player = player.name, message = rest, tick = game.tick, read = false, target_companion = id})
        game.print("[" .. player.name .. " -> " .. u.get_companion_display(id) .. "] " .. rest, u.print_color(comp.color or u.get_companion_color(id)))
        return
      end
    end
    local sub, args = param:match("^(%S+)%s*(.*)")
    if subcommands[sub] then subcommands[sub](player, args)
    else
      table.insert(storage.companion_messages, {player = player and player.name or "server", message = param, tick = game.tick, read = false})
      game.print("[" .. (player and player.name or "server") .. "] " .. param, u.print_color(u.COLORS.player))
    end
  end)
  if not ok then u.error_response(err, "fac"); game.print("Error: " .. tostring(err), u.print_color(u.COLORS.error)) end
end

commands.add_command("fac", "AI Companion", handle_fac)

require("commands.action")
require("commands.building")
require("commands.chat")
require("commands.companion")
require("commands.context")
require("commands.item")
require("commands.move")
require("commands.research")
require("commands.resource")
require("commands.world")
require("commands.combat")
require("commands.help")

-- Update companion map markers
local function update_companion_markers()
  if not storage.companion_markers then storage.companion_markers = {} end
  for cid, c in pairs(storage.companions) do
    if c.entity and c.entity.valid then
      local marker = storage.companion_markers[cid]
      local display = u.get_companion_display(cid)
      -- Create marker if doesn't exist
      if not marker or not marker.valid then
        local force = c.entity.force
        local surf = c.entity.surface
        marker = force.add_chart_tag(surf, {
          position = c.entity.position,
          text = display
        })
        storage.companion_markers[cid] = marker
      else
        -- Update marker position
        marker.position = c.entity.position
      end
    else
      -- Companion died/invalid, remove marker
      local marker = storage.companion_markers[cid]
      if marker and marker.valid then marker.destroy() end
      storage.companion_markers[cid] = nil
    end
  end
end

-- Pathfinding results arrive asynchronously (LuaSurface::request_path is non-blocking);
-- hand them off to the walking queue system that tracks the pending request map.
-- Unprotected, a raise here is an uncaught error in an event handler - takes the whole mod
-- down in a hosted multiplayer game. safe_tick logs instead of crashing (see its comment).
script.on_event(defines.events.on_script_path_request_finished, function(event)
  u.safe_tick("on_script_path_request_finished", function() queues.handle_path_result(event) end)
end)

-- Kills are credited by attribution (event.cause), not by inferring "the current combat
-- target slot went invalid" - see queues.handle_entity_died. Filtered to unit/unit-spawner/
-- turret, so this fires on every such death map-wide - the highest-frequency unprotected
-- path in the mod before safe_tick.
script.on_event(defines.events.on_entity_died, function(event)
  u.safe_tick("on_entity_died", function() queues.handle_entity_died(event) end)
end,
  {{filter = "type", type = "unit"}, {filter = "type", type = "unit-spawner"}, {filter = "type", type = "turret"}})

-- Each call wrapped individually (not the whole body in one pcall) so one queue's raise
-- doesn't skip the others on the same tick. Order is load-bearing: walk MUST stay last,
-- since a mining companion cannot walk (the engine reverts walking_state every tick while
-- mining_state.mining is true) - see the mining/walking mutual-exclusion note in CLAUDE.md.
script.on_nth_tick(5, function(ev)
  if ev.tick % 1800 == 0 then u.safe_tick("cleanup_messages", cleanup_messages) end
  -- Update map markers every 30 ticks (0.5 sec)
  if ev.tick % 30 == 0 then u.safe_tick("update_companion_markers", update_companion_markers) end
  -- Process all tick-based queues (realistic actions)
  u.safe_tick("tick_harvest_queues", queues.tick_harvest_queues)
  u.safe_tick("tick_craft_queues", queues.tick_craft_queues)
  u.safe_tick("tick_build_queues", queues.tick_build_queues)
  u.safe_tick("tick_combat_queues", queues.tick_combat_queues)
  u.safe_tick("tick_walk_queues", queues.tick_walk_queues)
end)
