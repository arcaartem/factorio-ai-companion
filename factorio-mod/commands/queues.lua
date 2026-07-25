-- AI Companion v0.9.0 - Tick-based queue system
local u = require("commands.init")

local M = {}

-- Constants
local TICK_INTERVAL = 5
local MIN_ACTION_TICKS = 30
local BUILD_TICKS = 60
local ATTACK_COOLDOWN = 15
local ATTACK_RANGE = 6
local MINING_RANGE = 5

-- Walk / pathfinding
local WAYPOINT_DIST = 1.0        -- distance to switch to the next path waypoint
local ARRIVE_DIST = 1.5          -- distance to consider the final target reached
local STUCK_MIN_DIST = 0.5       -- minimum net displacement per stuck-check window
local STUCK_TICKS = 180          -- ~3s of insufficient movement while walking = stuck
local FOLLOW_REPATH_TICKS = 60   -- minimum ticks between re-path requests while following
local FOLLOW_REPATH_DIST = 4     -- re-path if the followed player drifted this far from the last path's goal

-- Validate companion exists and is valid
local function valid_companion(id)
  local c = u.get_companion(id)
  return c and c.entity and c.entity.valid and c
end

-- Generic queue processor - eliminates repetition across all tick functions
local function process_queue(queue_name, processor)
  local queues = storage[queue_name]
  if not queues then return end

  local to_remove = {}
  for cid, q in pairs(queues) do
    local c = valid_companion(cid)
    if not c then
      to_remove[#to_remove + 1] = cid
    else
      local should_remove = processor(cid, q, c)
      if should_remove then to_remove[#to_remove + 1] = cid end
    end
  end

  for _, cid in ipairs(to_remove) do queues[cid] = nil end
end

function M.init()
  storage.harvest_queues = storage.harvest_queues or {}
  storage.craft_queues = storage.craft_queues or {}
  storage.build_queues = storage.build_queues or {}
  storage.combat_queues = storage.combat_queues or {}
  -- Outcome of the last finished combat round per companion. The queue is deleted on the
  -- same tick the final kill is counted, so this is the only way a terminal poll can see it.
  storage.combat_results = storage.combat_results or {}
end

-- ============ WALK ============
--
-- LuaSurface::request_path is asynchronous: it returns a request id immediately, and the
-- actual path (or failure) is delivered later via on_script_path_request_finished. Pending
-- requests are tracked in storage.path_requests (request id -> companion id) so the event
-- handler can find its way back to the right walking_queues entry, including the case where
-- that entry has since been replaced or cleared (move_stop, a new move_to, companion death).

local function cancel_request(q)
  -- self-heal if init_storage never ran this load (code hot-reloaded without a version bump,
  -- so on_configuration_changed did not fire and the field was never created)
  storage.path_requests = storage.path_requests or {}
  if q.request_id then
    storage.path_requests[q.request_id] = nil
    q.request_id = nil
  end
end

local function request_path(cid, c, goal)
  local q = storage.walking_queues[cid]
  if not q then return end
  cancel_request(q)
  local proto = c.entity.prototype
  -- bounding_box must be the prototype's unshifted collision_box (centered at {0,0}), not
  -- entity.bounding_box (which is shifted to the entity's current position) - a shifted box
  -- silently produces bogus/failing path requests.
  local ok, req_id = pcall(function()
    return c.entity.surface.request_path{
      bounding_box = proto.collision_box,
      collision_mask = proto.collision_mask,
      start = c.entity.position,
      goal = goal,
      force = c.entity.force,
      radius = 1,
      can_open_gates = true,
      entity_to_ignore = c.entity,
      pathfind_flags = {
        allow_paths_through_own_entities = true,
        cache = false,
        prefer_straight_paths = true
      }
    }
  end)
  if ok and req_id then
    storage.path_requests[req_id] = cid
    q.request_id = req_id
    q.status = "requesting"
    q.path = nil
    q.path_index = nil
    q.path_goal = {x = goal.x, y = goal.y}
    q.last_path_tick = game.tick
  else
    q.status = "no_path"
    -- Stamp the attempt even when the request never got made: the follow re-path backoff
    -- keys off last_path_tick, and leaving it unset here would retry every single tick.
    q.last_path_tick = game.tick
  end
end

-- Invoked from control.lua's on_script_path_request_finished handler.
function M.handle_path_result(event)
  storage.path_requests = storage.path_requests or {}
  local cid = storage.path_requests[event.id]
  if cid == nil then return end -- stale/unknown/already superseded request
  storage.path_requests[event.id] = nil

  local q = storage.walking_queues[cid]
  if not q or q.request_id ~= event.id then return end -- queue replaced/cleared meanwhile
  q.request_id = nil

  local c = valid_companion(cid)
  if not c then storage.walking_queues[cid] = nil; return end

  if not event.path or #event.path == 0 then
    -- try_again_later means the pathfinder was overloaded, not that the goal is unreachable -
    -- retry a bounded number of times before giving up for real.
    if event.try_again_later and (q.busy_retries or 0) < 3 then
      q.busy_retries = (q.busy_retries or 0) + 1
      request_path(cid, c, q.target)
    else
      q.status = "no_path"
      c.entity.walking_state = {walking = false}
    end
    return
  end

  q.busy_retries = 0
  q.path = event.path
  q.path_index = 1
  q.status = "walking"
  q.last_position = {x = c.entity.position.x, y = c.entity.position.y}
  q.stuck_ticks = 0
  q.stuck_retried = false
end

function M.start_walk(cid, target)
  local c = valid_companion(cid)
  if not c then return {error = "Invalid companion"} end

  local existing = storage.walking_queues[cid]
  -- Idempotent poll: repeating the same target while already requesting/walking just
  -- reports current status instead of restarting the pathfind - this is also how the
  -- orchestrator polls for arrival, by calling move_to again with the same coordinates.
  if existing and not existing.follow_player and existing.target
     and u.distance(existing.target, target) < WAYPOINT_DIST
     and (existing.status == "requesting" or existing.status == "walking") then
    return M.get_walk_status(cid)
  end
  if existing then cancel_request(existing) end

  if u.distance(c.entity.position, target) < ARRIVE_DIST then
    storage.walking_queues[cid] = nil
    c.entity.walking_state = {walking = false}
    return {started = true, active = false, status = "arrived", target = {x = target.x, y = target.y}}
  end

  storage.walking_queues[cid] = {target = {x = target.x, y = target.y}, status = "requesting", busy_retries = 0}
  request_path(cid, c, target)
  local result = M.get_walk_status(cid)
  result.started = true
  return result
end

function M.start_follow(cid, player_name)
  local c = valid_companion(cid)
  if not c then return {error = "Invalid companion"} end
  local player = game.get_player(player_name)
  if not player or not player.valid then return {error = "Player not found"} end

  local existing = storage.walking_queues[cid]
  if existing then cancel_request(existing) end

  storage.walking_queues[cid] = {
    follow_player = player_name,
    target = {x = player.position.x, y = player.position.y},
    status = "requesting",
    busy_retries = 0
  }
  request_path(cid, c, player.position)
  local result = M.get_walk_status(cid)
  result.started = true
  return result
end

function M.stop_walk(cid)
  local q = storage.walking_queues[cid]
  if q then cancel_request(q) end
  storage.walking_queues[cid] = nil
  local c = valid_companion(cid)
  if c then c.entity.walking_state = {walking = false} end
  return {stopped = true}
end

-- Status: "requesting" | "walking" | "arrived" | "no_path" | "stuck", or active=false/"idle"
-- when there is no queue at all.
function M.get_walk_status(cid)
  local q = storage.walking_queues[cid]
  if not q then return {active = false, status = "idle"} end
  local result = {active = true, status = q.status, target = q.target}
  if q.follow_player then result.following = q.follow_player end
  local c = valid_companion(cid)
  if c and q.target then
    result.distance_remaining = math.floor(u.distance(c.entity.position, q.target) * 10) / 10
  end
  return result
end

function M.tick_walk_queues()
  process_queue("walking_queues", function(cid, q, c)
    local e = c.entity

    if q.follow_player then
      local p = game.get_player(q.follow_player)
      if not p or not p.valid then
        cancel_request(q)
        e.walking_state = {walking = false}
        return true
      end
      q.target = {x = p.position.x, y = p.position.y}
    end

    if not q.target then return true end

    local dist_to_target = u.distance(e.position, q.target)

    -- Re-checked every tick (not just once) since a follow target can walk back into range.
    if dist_to_target < ARRIVE_DIST then
      e.walking_state = {walking = false}
      q.status = "arrived"
      cancel_request(q)
      return not q.follow_player
    end

    -- "arrived"/"no_path"/"stuck" only resume automatically for a follow target that has
    -- drifted back out of range; otherwise they sit until an explicit move_to/move_follow.
    local need_path = (q.status == "arrived" or q.status == "no_path" or q.status == "stuck")
    if q.follow_player and not need_path then
      local drifted = not q.path_goal or u.distance(q.path_goal, q.target) > FOLLOW_REPATH_DIST
      local can_repath = (game.tick - (q.last_path_tick or 0)) >= FOLLOW_REPATH_TICKS
      need_path = drifted and can_repath
    end

    if need_path then
      if q.status == "stuck" or q.status == "no_path" then
        e.walking_state = {walking = false}
        -- Terminal for a plain move_to: it sits until an explicit re-issue, as documented.
        -- A follow target must not latch though - losing the path for a moment (the player
        -- rounds a wall, crosses water, a gate closes) would otherwise freeze the companion
        -- forever, contradicting the promise above. Retry on the same backoff the drift
        -- path uses, and hand the recovered queue a fresh stuck/busy budget.
        if not q.follow_player then return false end
        if (game.tick - (q.last_path_tick or 0)) < FOLLOW_REPATH_TICKS then return false end
        q.stuck_retried = false
        q.stuck_ticks = 0
        q.busy_retries = 0
      end
      request_path(cid, c, q.target)
      return false
    end

    if q.status == "requesting" then
      e.walking_state = {walking = false} -- hold position until the async path arrives
      return false
    end

    if q.status ~= "walking" or not q.path or not q.path_index or q.path_index > #q.path then
      request_path(cid, c, q.target)
      return false
    end

    -- Advance through waypoints toward the final target
    local waypoint = q.path[q.path_index].position
    if u.distance(e.position, waypoint) < WAYPOINT_DIST then
      q.path_index = q.path_index + 1
      waypoint = (q.path_index <= #q.path) and q.path[q.path_index].position or q.target
    end

    local dir = u.get_direction(e.position, waypoint)
    if dir then e.walking_state = {walking = true, direction = dir} else e.walking_state = {walking = false} end

    -- Stuck detection: net displacement since the last check, not per-tick movement, so
    -- brief oscillation against an obstacle still counts as "not making progress".
    if not q.last_position then q.last_position = {x = e.position.x, y = e.position.y} end
    if u.distance(e.position, q.last_position) < STUCK_MIN_DIST then
      q.stuck_ticks = (q.stuck_ticks or 0) + TICK_INTERVAL
    else
      q.stuck_ticks = 0
      q.last_position = {x = e.position.x, y = e.position.y}
    end

    if q.stuck_ticks >= STUCK_TICKS then
      q.stuck_ticks = 0
      q.last_position = {x = e.position.x, y = e.position.y}
      if not q.stuck_retried then
        -- First stall: the obstruction (another unit, a closed gate) or the path itself
        -- might be stale - request a fresh path once before giving up.
        q.stuck_retried = true
        request_path(cid, c, q.target)
      else
        e.walking_state = {walking = false}
        q.status = "stuck"
      end
    end

    return false
  end)
end

-- ============ HARVEST ============

function M.start_harvest(cid, position, target_count, resource_name)
  local c = valid_companion(cid)
  if not c then return {error = "Invalid companion"} end

  -- Filter by resource name if specified, otherwise get all resources
  local filter = {position = position, radius = 3, type = "resource"}
  if resource_name then filter.name = resource_name end

  local entities = c.entity.surface.find_entities_filtered(filter)
  if #entities == 0 then return {error = "No resource"} end

  table.sort(entities, function(a, b)
    return u.distance(a.position, c.entity.position) < u.distance(b.position, c.entity.position)
  end)

  storage.harvest_queues[cid] = {
    entities = entities,
    position = position,
    target = target_count,
    harvested = 0,
    current = nil,
    resource_name = resource_name
  }

  M.start_mining_next(cid)
  -- Set inv_snapshot immediately after starting mining
  storage.harvest_queues[cid].inv_snapshot = u.contents_to_map(c.entity.get_main_inventory().get_contents())
  return {started = true, entities = #entities, target = target_count, resource = resource_name}
end

function M.start_mining_next(cid)
  local q = storage.harvest_queues[cid]
  if not q then return false end

  local c = valid_companion(cid)
  if not c then
    storage.harvest_queues[cid] = nil
    return false
  end

  while #q.entities > 0 do
    local entity = table.remove(q.entities, 1)
    if entity and entity.valid then
      c.entity.update_selected_entity(entity.position)
      c.entity.mining_state = {mining = true, position = entity.position}
      q.current = {
        entity = entity,
        start_tick = game.tick,
        mining_time = (entity.prototype.mineable_properties.mining_time or 1) * 60
      }
      return true
    end
  end
  return false
end

function M.tick_harvest_queues()
  process_queue("harvest_queues", function(cid, q, c)
    -- Target reached
    if q.harvested >= q.target then
      c.entity.mining_state = {mining = false}
      return true
    end

    -- Too far from mining area (reach enforcement is opt-in via c.realistic)
    if c.realistic then
      local limit = c.entity.resource_reach_distance or MINING_RANGE
      if u.distance(c.entity.position, q.position) > limit then
        c.entity.mining_state = {mining = false}
        u.log_error("harvest aborted: too far", "companion " .. cid)
        return true
      end
    end

    -- Start mining first resource
    if not q.current then
      if not M.start_mining_next(cid) then
        c.entity.mining_state = {mining = false}
        return true
      end
      q.inv_snapshot = u.contents_to_map(c.entity.get_main_inventory().get_contents())
      return false
    end

    local current = q.current

    -- HYBRID: Let Factorio mine natively, monitor mining_state
    -- When mining stops (entity depleted or finished), count inventory and move to next
    if not c.entity.mining_state or not c.entity.mining_state.mining then
      -- Mining stopped - count what we got
      -- Hot-reload guard: an old save may have persisted the pre-2.0 array-shaped snapshot.
      if type(q.inv_snapshot[1]) == "table" then
        q.inv_snapshot = u.contents_to_map(q.inv_snapshot)
      end
      local inv_after = u.contents_to_map(c.entity.get_main_inventory().get_contents())
      local added = 0
      for name, count in pairs(inv_after) do
        added = added + math.max(0, count - (q.inv_snapshot[name] or 0))
      end
      q.harvested = q.harvested + added

      -- Check if target reached
      if q.harvested >= q.target then
        c.entity.mining_state = {mining = false}
        return true
      end

      -- Move to next resource
      q.current = nil
      if not M.start_mining_next(cid) then
        c.entity.mining_state = {mining = false}
        return true
      end
      q.inv_snapshot = u.contents_to_map(c.entity.get_main_inventory().get_contents())
    end

    return false
  end)
end

function M.get_harvest_status(cid)
  local q = storage.harvest_queues[cid]
  if not q then return {active = false} end
  return {
    active = true,
    harvested = q.harvested,
    target = q.target,
    remaining = #q.entities,
    mining = q.current ~= nil
  }
end

function M.stop_harvest(cid)
  local q = storage.harvest_queues[cid]
  if not q then return {stopped = false} end

  local c = valid_companion(cid)
  if c then c.entity.mining_state = {mining = false} end

  local harvested = q.harvested
  storage.harvest_queues[cid] = nil
  return {stopped = true, harvested = harvested}
end

-- ============ CRAFT ============

function M.start_craft(cid, recipe, count)
  local c = valid_companion(cid)
  if not c then return {error = "Invalid companion"} end

  local proto = prototypes.recipe[recipe]
  if not proto then return {error = "Unknown recipe: " .. recipe} end

  local craftable = c.entity.get_craftable_count(recipe)
  if craftable < 1 then return {error = "Missing ingredients"} end

  local actual = math.min(count, craftable)
  local ticks = math.max(MIN_ACTION_TICKS, (proto.energy or 0.5) * 60)

  storage.craft_queues[cid] = {
    recipe = recipe,
    target = actual,
    crafted = 0,
    ticks_per = ticks,
    tick_start = game.tick
  }

  return {started = true, recipe = recipe, target = actual, ticks_per = ticks}
end

function M.tick_craft_queues()
  process_queue("craft_queues", function(cid, q, c)
    local elapsed = game.tick - q.tick_start
    if elapsed < q.ticks_per then return false end

    local crafted = c.entity.begin_crafting{recipe = q.recipe, count = 1}
    if crafted < 1 then return true end

    q.crafted = q.crafted + 1
    q.tick_start = game.tick
    return q.crafted >= q.target
  end)
end

function M.get_craft_status(cid)
  local q = storage.craft_queues[cid]
  if not q then return {active = false} end
  return {
    active = true,
    recipe = q.recipe,
    crafted = q.crafted,
    target = q.target,
    progress = math.floor((game.tick - q.tick_start) / q.ticks_per * 100)
  }
end

function M.stop_craft(cid)
  local q = storage.craft_queues[cid]
  if not q then return {stopped = false} end
  local crafted = q.crafted
  storage.craft_queues[cid] = nil
  return {stopped = true, crafted = crafted}
end

-- ============ BUILD ============

function M.start_build(cid, entity_name, position, direction)
  local c = valid_companion(cid)
  if not c then return {error = "Invalid companion"} end

  local dir = direction or defines.direction.north
  local reach_err = u.check_reach(cid, c, position)
  if reach_err then return reach_err end

  local inv = c.entity.get_main_inventory()
  if inv.get_item_count(entity_name) < 1 then
    return {error = "No " .. entity_name .. " in inventory"}
  end

  local surface = c.entity.surface
  if not surface.can_place_entity{name = entity_name, position = position, direction = dir, force = c.entity.force} then
    return {error = "Cannot place here"}
  end

  storage.build_queues[cid] = {
    entity = entity_name,
    position = position,
    direction = dir,
    tick_start = game.tick
  }

  return {started = true, entity = entity_name, position = position}
end

function M.tick_build_queues()
  process_queue("build_queues", function(cid, q, c)
    if game.tick - q.tick_start < BUILD_TICKS then return false end

    local placed = c.entity.surface.create_entity{
      name = q.entity,
      position = q.position,
      direction = q.direction,
      force = c.entity.force
    }
    if placed then c.entity.remove_item{name = q.entity, count = 1} end
    return true
  end)
end

function M.get_build_status(cid)
  local q = storage.build_queues[cid]
  if not q then return {active = false} end
  return {
    active = true,
    entity = q.entity,
    position = q.position,
    progress = math.floor((game.tick - q.tick_start) / BUILD_TICKS * 100)
  }
end

function M.stop_build(cid)
  if not storage.build_queues[cid] then return {stopped = false} end
  storage.build_queues[cid] = nil
  return {stopped = true}
end

-- ============ COMBAT ============

function M.start_combat(cid, target_pos)
  local c = valid_companion(cid)
  if not c then return {error = "Invalid companion"} end

  local enemies = c.entity.surface.find_entities_filtered{
    position = target_pos,
    radius = 10,
    force = "enemy",
    type = {"unit", "unit-spawner"}
  }
  if #enemies == 0 then return {error = "No enemies"} end

  table.sort(enemies, function(a, b)
    return u.distance(a.position, c.entity.position) < u.distance(b.position, c.entity.position)
  end)

  storage.combat_queues[cid] = {
    targets = enemies,
    current = enemies[1],
    cooldown = 0,
    kills = 0
  }
  -- kills is per-round, so drop the previous round's result: a poll on this round must not
  -- be able to read a stale total from the last one.
  storage.combat_results = storage.combat_results or {}
  storage.combat_results[cid] = nil

  return {started = true, targets = #enemies}
end

function M.tick_combat_queues()
  process_queue("combat_queues", function(cid, q, c)
    if q.cooldown > 0 then
      q.cooldown = q.cooldown - TICK_INTERVAL
      return false
    end

    if not q.current or not q.current.valid then
      if q.current then q.kills = (q.kills or 0) + 1 end
      -- Find next valid target (build new list to avoid mutation during iteration)
      local valid_targets = {}
      for _, t in ipairs(q.targets) do
        if t.valid then valid_targets[#valid_targets + 1] = t end
      end
      q.targets = valid_targets

      if #q.targets == 0 then
        c.entity.shooting_state = {state = defines.shooting.not_shooting}
        -- The kill counted just above lands on the same tick this queue is torn down, so
        -- without persisting it the final kill - the only kill, against a single enemy -
        -- could never be read back.
        storage.combat_results = storage.combat_results or {}
        storage.combat_results[cid] = {kills = q.kills or 0, ended_tick = game.tick}
        return true
      end
      q.current = table.remove(q.targets, 1)
    end

    local dist = u.distance(c.entity.position, q.current.position)

    if dist <= ATTACK_RANGE then
      c.entity.shooting_state = {
        state = defines.shooting.shooting_enemies,
        position = q.current.position
      }
      q.cooldown = ATTACK_COOLDOWN
    else
      c.entity.shooting_state = {state = defines.shooting.not_shooting}
      local dir = u.get_direction(c.entity.position, q.current.position)
      if dir then c.entity.walking_state = {walking = true, direction = dir} end
    end
    return false
  end)
end

function M.get_combat_status(cid)
  local q = storage.combat_queues[cid]
  if not q then
    -- Terminal poll: this is the branch combat_until actually reads its total from.
    local last = (storage.combat_results or {})[cid]
    return {active = false, kills = last and last.kills or 0, ended_tick = last and last.ended_tick or nil}
  end

  local remaining = #q.targets
  if q.current and q.current.valid then remaining = remaining + 1 end

  return {
    active = true,
    targets_remaining = remaining,
    current_target = q.current and q.current.valid and q.current.name or nil,
    kills = q.kills or 0
  }
end

function M.stop_combat(cid)
  local q = storage.combat_queues[cid]
  if not q then return {stopped = false, kills = 0} end

  local c = valid_companion(cid)
  if c then
    c.entity.shooting_state = {state = defines.shooting.not_shooting}
    c.entity.walking_state = {walking = false}
  end

  -- combat.lua's wrapper has always reported `result.kills or 0`; until now this returned
  -- no kills at all, so an interrupted round (the low-health retreat) always read as zero.
  local kills = q.kills or 0
  storage.combat_results = storage.combat_results or {}
  storage.combat_results[cid] = {kills = kills, ended_tick = game.tick}

  storage.combat_queues[cid] = nil
  return {stopped = true, kills = kills}
end

return M
