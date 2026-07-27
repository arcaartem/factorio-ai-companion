-- AI Companion v0.9.0 - Tick-based queue system
local u = require("commands.init")

local M = {}

-- Constants
local TICK_INTERVAL = 5
local MIN_ACTION_TICKS = 30
local BUILD_TICKS = 60
local ATTACK_COOLDOWN = 15
local ATTACK_RANGE = 6
local HARVEST_STALL_TICKS = 900 -- 15s with no harvested-count progress = give up (last-resort
                                 -- exit; the reach/movement-yield paths can legitimately block
                                 -- forever, e.g. a latched "no_path" walk queue)
local UNCAUSED_DEATH_RADIUS = 20 -- bounds the q.uncaused diagnostic to queues whose companion is plausibly
                                  -- involved in a given unattributed death, so one stray death doesn't
                                  -- inflate the count on every OTHER active combat queue too (see handle_entity_died)

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

-- Generic queue processor - eliminates repetition across all tick functions.
-- on_drop(cid, q), if given, runs when the companion itself has become invalid (died,
-- despawned) right before its queue entry is discarded - the combat queue uses this to
-- persist the round's kills, which would otherwise vanish along with the queue.
local function process_queue(queue_name, processor, on_drop)
  local queues = storage[queue_name]
  if not queues then return end

  local to_remove = {}
  for cid, q in pairs(queues) do
    local c = valid_companion(cid)
    if not c then
      if on_drop then on_drop(cid, q) end
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

-- Terminates a harvest queue and records its outcome so a poll arriving AFTER the queue is
-- gone (M.get_harvest_status finding storage.harvest_queues[cid] == nil) can still read the
-- final harvested count and why it stopped - the queue itself is deleted by the caller
-- (process_queue's to_remove, or M.stop_harvest directly), not here.
local function finish_harvest(cid, q, c, reason)
  c.entity.mining_state = {mining = false}
  -- Nil-guard: control-stage reload does not run on_configuration_changed, so a save from
  -- before this field existed never gets it from init_storage.
  storage.harvest_results = storage.harvest_results or {}
  storage.harvest_results[cid] = {harvested = q.harvested, target = q.target, reason = reason, tick = game.tick}
  return true
end

function M.start_harvest(cid, position, target_count, resource_name)
  local c = valid_companion(cid)
  if not c then return {error = "Invalid companion"} end

  -- Filter by resource name if specified, otherwise get all resources. A named token is
  -- resolved through u.resource_filter so "wood"/"tree" seeds the pool by type = "tree"
  -- rather than by a name no tree prototype actually has.
  local filter = {position = position, radius = 3}
  if resource_name then
    for k, v in pairs(u.resource_filter(resource_name)) do filter[k] = v end
  else
    filter.type = "resource"
  end

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
  -- Drop any stale result from a previous run - a poll on this new run must never be able to
  -- read a leftover outcome that belongs to the last one.
  storage.harvest_results = storage.harvest_results or {}
  storage.harvest_results[cid] = nil

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

  -- start_harvest seeds the pool from a radius-3 search around the target position, but the
  -- engine's own resource reach is only resource_reach_distance (2.7) - an entity beyond that
  -- would sit in mining_state forever without ever actually mining (see tick_harvest_queues).
  local reach = c.entity.resource_reach_distance or 10
  while #q.entities > 0 do
    local entity = table.remove(q.entities, 1)
    if entity and entity.valid and u.distance(entity.position, c.entity.position) <= reach then
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
    -- Nil-guard: a queue persisted from a save that predates this field never gets it from
    -- init_storage (control-stage reload does not run on_configuration_changed).
    q.last_progress_tick = q.last_progress_tick or game.tick

    -- Target reached
    if q.harvested >= q.target then
      return finish_harvest(cid, q, c, "target_reached")
    end

    -- Too far from mining area (reach enforcement is always on, see check_reach)
    if u.check_reach(cid, c, q.position, "resource") then
      u.log_error("harvest aborted: too far", "companion " .. cid)
      return finish_harvest(cid, q, c, "too_far")
    end

    -- The engine refuses to move a character whose mining_state.mining is true - it silently
    -- reverts walking_state every tick instead. Pause mining (not the queue) whenever a walk
    -- or combat queue is actively trying to move the companion, or the two fight forever.
    -- "no_path"/"stuck" are latched terminal states though: yielding to those would just swap
    -- one permanent deadlock for another, so they don't count as "moving".
    local walk_q = storage.walking_queues[cid]
    local walk_moving = walk_q and (walk_q.status == "requesting" or walk_q.status == "walking")
    local combat_q = storage.combat_queues and storage.combat_queues[cid]
    local combat_moving = combat_q and combat_q.current and combat_q.current.valid
      and (combat_q.cooldown or 0) <= 0
      and u.distance(c.entity.position, combat_q.current.position) > ATTACK_RANGE
    if walk_moving or combat_moving then
      if c.entity.mining_state and c.entity.mining_state.mining then
        c.entity.mining_state = {mining = false}
      end
      return false
    end

    -- Start mining first resource
    if not q.current then
      if not M.start_mining_next(cid) then
        return finish_harvest(cid, q, c, "pool_empty")
      end
      q.inv_snapshot = u.contents_to_map(c.entity.get_main_inventory().get_contents())
      return false
    end

    -- Hot-reload guard: an old save may have persisted the pre-2.0 array-shaped snapshot.
    if type(q.inv_snapshot[1]) == "table" then
      q.inv_snapshot = u.contents_to_map(q.inv_snapshot)
    end

    -- Count every tick, unconditionally: mining_state.mining stays true for as long as the
    -- ore tile still has ore (the resource entity just decrements `amount`, never gets
    -- consumed per ore), so a "mining stopped" guard here would never fire and harvested
    -- would stay 0 forever while the inventory kept rising underneath it.
    local inv_after = u.contents_to_map(c.entity.get_main_inventory().get_contents())
    local added = 0
    for name, count in pairs(inv_after) do
      added = added + math.max(0, count - (q.inv_snapshot[name] or 0))
    end
    q.harvested = q.harvested + added
    q.inv_snapshot = inv_after
    if added > 0 then q.last_progress_tick = game.tick end

    if q.harvested >= q.target then
      return finish_harvest(cid, q, c, "target_reached")
    end

    if not q.current.entity.valid then
      -- Tile depleted and destroyed - move to next resource
      q.current = nil
      if not M.start_mining_next(cid) then
        return finish_harvest(cid, q, c, "pool_empty")
      end
      q.inv_snapshot = u.contents_to_map(c.entity.get_main_inventory().get_contents())
    elseif not c.entity.mining_state or not c.entity.mining_state.mining then
      -- Entity is still valid but the engine isn't mining it (e.g. resuming after a
      -- movement-yield above) - re-assert on the same entity rather than discarding a
      -- partly-mined tile.
      local entity = q.current.entity
      c.entity.update_selected_entity(entity.position)
      c.entity.mining_state = {mining = true, position = entity.position}
    end

    -- Stall guard: every other exit above requires either reach or movement, both of which
    -- can be legitimately blocked forever - this is the last-resort timeout that guarantees
    -- termination.
    if game.tick - q.last_progress_tick >= HARVEST_STALL_TICKS then
      u.log_error("harvest stalled: no progress for " .. HARVEST_STALL_TICKS .. " ticks", "companion " .. cid)
      return finish_harvest(cid, q, c, "stalled")
    end

    return false
  end)
end

function M.get_harvest_status(cid)
  local q = storage.harvest_queues[cid]
  if not q then
    -- The queue is gone (self-terminated or stopped) - the only way a poll arriving after
    -- that can still see the final count is the outcome finish_harvest recorded.
    local last = (storage.harvest_results or {})[cid]
    if last then
      return {active = false, harvested = last.harvested, target = last.target, reason = last.reason}
    end
    return {active = false}
  end
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

  local harvested = q.harvested
  local c = valid_companion(cid)
  if c then finish_harvest(cid, q, c, "stopped") end

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

  -- Pick up whatever's already in the companion's own inventory (e.g. via item_pick /
  -- building_empty since spawning) before failing - "use what you have" needs no new command.
  u.arm_from(c.entity, c.entity.get_main_inventory())
  if not u.equipped_gun(c.entity) then return {error = "No weapon equipped"} end
  if u.loaded_ammo_count(c.entity) < 1 then return {error = "No ammo"} end

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
    kills = 0,
    uncaused = 0
  }
  -- kills is per-round, so drop the previous round's result: a poll on this round must not
  -- be able to read a stale total from the last one.
  storage.combat_results = storage.combat_results or {}
  storage.combat_results[cid] = nil

  return {started = true, targets = #enemies}
end

-- Companions credit kills by attribution (event.cause from on_entity_died), not by
-- inferring "the current target slot went invalid" - that inference over-counted (any
-- death reason credited the companion) and dropped every bystander kill in a cluster.
function M.handle_entity_died(event)
  storage.combat_queues = storage.combat_queues or {}
  storage.companions = storage.companions or {}
  local dead = event.entity
  if not dead or not dead.valid then return end

  local cause = event.cause
  if cause and cause.valid then
    for cid, q in pairs(storage.combat_queues) do
      local c = u.get_companion(cid)
      if c and c.entity == cause then
        q.kills = (q.kills or 0) + 1
        return
      end
    end
  end

  -- Diagnostic only, not a kill count: distinguishes "the companion genuinely didn't
  -- kill it" from "event.cause isn't populated for character gun fire at all" - the one
  -- API assumption that couldn't be verified without shipping this handler. Bounded by
  -- distance so one unattributed death doesn't inflate this on every OTHER companion's
  -- queue too - only a queue whose companion is plausibly nearby counts it.
  if dead.force and dead.force.name == "enemy" then
    for cid, q in pairs(storage.combat_queues) do
      local c = u.get_companion(cid)
      if c and c.entity and c.entity.valid and u.distance(dead.position, c.entity.position) <= UNCAUSED_DEATH_RADIUS then
        q.uncaused = (q.uncaused or 0) + 1
      end
    end
  end
end

function M.tick_combat_queues()
  process_queue("combat_queues", function(cid, q, c)
    if q.cooldown > 0 then
      q.cooldown = q.cooldown - TICK_INTERVAL
      return false
    end

    if not q.current or not q.current.valid then
      -- Kills are now credited by handle_entity_died via event.cause (see start_combat's
      -- comment above it) - this pass only prunes dead entities from the pool and drives
      -- round completion; it deliberately no longer increments q.kills itself.
      local valid_targets = {}
      for _, t in ipairs(q.targets) do
        if t.valid then valid_targets[#valid_targets + 1] = t end
      end
      q.targets = valid_targets

      if #q.targets == 0 then
        c.entity.shooting_state = {state = defines.shooting.not_shooting}
        -- The round ends on this same tick the queue is torn down, so without persisting
        -- here the final kill(s) could never be read back.
        storage.combat_results = storage.combat_results or {}
        storage.combat_results[cid] = {kills = q.kills or 0, uncaused = q.uncaused or 0, ended_tick = game.tick}
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
  end, function(cid, q)
    -- Companion died/vanished mid-fight: persist the round's kills before process_queue
    -- drops the queue, else stop_combat/get_combat_status could never read them back.
    storage.combat_results = storage.combat_results or {}
    storage.combat_results[cid] = {kills = q.kills or 0, uncaused = q.uncaused or 0, ended_tick = game.tick}
  end)
end

function M.get_combat_status(cid)
  local q = storage.combat_queues[cid]
  if not q then
    -- Terminal poll: this is the branch combat_until actually reads its total from.
    local last = (storage.combat_results or {})[cid]
    return {
      active = false,
      kills = last and last.kills or 0,
      ended_tick = last and last.ended_tick or nil,
      uncaused_deaths = last and last.uncaused or 0
    }
  end

  local remaining = #q.targets
  if q.current and q.current.valid then remaining = remaining + 1 end

  return {
    active = true,
    targets_remaining = remaining,
    current_target = q.current and q.current.valid and q.current.name or nil,
    kills = q.kills or 0,
    uncaused_deaths = q.uncaused or 0
  }
end

function M.stop_combat(cid)
  local q = storage.combat_queues[cid]
  if not q then
    -- The queue may have completed (or dropped, see process_queue's on_drop) just before
    -- this stop arrived - read the persisted total instead of hard-coding zero.
    local last = (storage.combat_results or {})[cid]
    return {stopped = false, kills = last and last.kills or 0, uncaused_deaths = last and last.uncaused or 0}
  end

  local c = valid_companion(cid)
  if c then
    c.entity.shooting_state = {state = defines.shooting.not_shooting}
    c.entity.walking_state = {walking = false}
  end

  -- combat.lua's wrapper has always reported `result.kills or 0`; until now this returned
  -- no kills at all, so an interrupted round (the low-health retreat) always read as zero.
  local kills = q.kills or 0
  local uncaused = q.uncaused or 0
  storage.combat_results = storage.combat_results or {}
  storage.combat_results[cid] = {kills = kills, uncaused = uncaused, ended_tick = game.tick}

  storage.combat_queues[cid] = nil
  return {stopped = true, kills = kills, uncaused_deaths = uncaused}
end

return M
