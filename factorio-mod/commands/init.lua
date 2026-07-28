-- AI Companion v0.20.0
local M = {}

M.COLORS = {
  player = {r=0.4, g=0.8, b=1},
  orchestrator = {r=0.3, g=1, b=0.3},
  system = {r=1, g=0.5, b=0},
  error = {r=1, g=0, b=0}
}

M.COMPANION_COLORS = {
  {r=1, g=0.6, b=0.2}, {r=0.8, g=0.4, b=1}, {r=1, g=1, b=0.3}, {r=0.4, g=1, b=0.8},
  {r=1, g=0.4, b=0.6}, {r=0.6, g=0.8, b=1}, {r=1, g=0.8, b=0.4}, {r=0.7, g=1, b=0.5}
}

M.dir_map = {
  [0] = defines.direction.north, [1] = defines.direction.east,
  [2] = defines.direction.south, [3] = defines.direction.west
}

function M.print_color(c) return {color = c} end

function M.get_companion_color(id)
  return M.COMPANION_COLORS[((id - 1) % #M.COMPANION_COLORS) + 1]
end

function M.json_response(data)
  local ok, result = pcall(helpers.table_to_json, data)
  rcon.print(ok and result or '{"error":"JSON failed"}')
end

function M.log_error(msg, ctx)
  if storage.errors then
    table.insert(storage.errors, {context = ctx or "rcon", error = tostring(msg), tick = game.tick})
    if #storage.errors > 50 then table.remove(storage.errors, 1) end
  end
end

function M.error_response(msg, ctx)
  M.log_error(msg, ctx)
  local ok, out = pcall(helpers.table_to_json, {error = tostring(msg)})
  rcon.print(ok and out or '{"error":"error encoding failed"}')
end

-- Factorio 2.0: get_contents() returns an array of {name, count, quality} records.
-- Sums across qualities into a plain name -> count map.
function M.contents_to_map(contents)
  local map = {}
  for _, item in pairs(contents) do
    map[item.name] = (map[item.name] or 0) + item.count
  end
  return map
end

function M.safe_command(callback)
  local ok, err = pcall(callback)
  if not ok then
    M.error_response(err)
  end
end

function M.get_companion(id)
  local c = storage.companions[id]
  return (c and c.entity and c.entity.valid) and c or nil
end

function M.find_companion(identifier)
  local id = tonumber(identifier)
  if id then
    local c = M.get_companion(id)
    if c then return id, c end
  end
  for cid, c in pairs(storage.companions) do
    if c.name and c.name:lower() == identifier:lower() and c.entity and c.entity.valid then
      return cid, c
    end
  end
  return nil, nil
end

function M.get_companion_display(id)
  local c = storage.companions[id]
  return c and c.name and (c.name .. "(#" .. id .. ")") or ("#" .. id)
end

function M.parse_args(pattern, args)
  return args and {args:match(pattern)} or {}
end

function M.distance(a, b)
  return math.sqrt((a.x - b.x)^2 + (a.y - b.y)^2)
end

-- ============ NEAREST SEARCH ============
-- find_entities_filtered's `limit` truncates in the engine's own chunk order, which carries no
-- distance ordering at all - so scanning a wide area with a limit and then picking the minimum
-- yields "nearest of an arbitrary sample", not "nearest". Live-probed returning iron-ore at
-- distance 155 while iron-ore sat at 85.5 from the same position.
--
-- An UNLIMITED circular search is complete by construction: if it returns anything, the closest
-- member is the true global nearest, because everything omitted lies outside the circle and so
-- is farther than the circle's own radius. Growing the radius from small keeps the common case
-- (the resource is right there) cheap, and only pays for a wide scan when the surroundings
-- genuinely are empty - which is exactly when the wide scan returns few entities.
M.SEARCH_RADII = {8, 16, 32, 64, 128, 200}
M.SEARCH_MAX_RADIUS = M.SEARCH_RADII[#M.SEARCH_RADII]

M.RESOURCE_ALIASES = {
  copper = "copper-ore", iron = "iron-ore", coal = "coal",
  stone = "stone", uranium = "uranium-ore", oil = "crude-oil"
}

function M.normalize_resource(token)
  return M.RESOURCE_ALIASES[token] or token
end

-- Wood is the one harvestable that cannot be selected by name: trees ship dozens of
-- prototypes (tree-01 .. dead-dry-hairy-tree), so they are selected by TYPE while ores are
-- selected by name. Callers pass a single token and get the find_entities_filtered fragment
-- that selects it, which keeps that split in one place instead of at each call site.
function M.is_wood(token) return token == "wood" or token == "tree" end

function M.resource_filter(token)
  if M.is_wood(token) then return {type = "tree"} end
  return {name = M.normalize_resource(token)}
end

local function closest_of(items, pos, position_of)
  local best, min = nil, math.huge
  for _, item in ipairs(items) do
    local d = M.distance(position_of(item), pos)
    if d < min then min, best = d, item end
  end
  return best, min
end

local function entity_position(e) return e.position end
local function tile_position(t) return t.position end

-- filter is a find_entities_filtered table WITHOUT position/radius, e.g. {name = "iron-ore"}
-- or {type = "tree"}. Returns entity, distance - or nil when nothing matches within
-- SEARCH_MAX_RADIUS.
function M.find_nearest(surface, pos, filter)
  for _, radius in ipairs(M.SEARCH_RADII) do
    local search = {position = pos, radius = radius}
    for k, v in pairs(filter) do search[k] = v end
    local es = surface.find_entities_filtered(search)
    if #es > 0 then
      local best, min = closest_of(es, pos, entity_position)
      -- radius selection is bounding-box based, so an entity whose CENTRE sits just outside
      -- the radius can still come back. When that happens the circle we searched did not cover
      -- everything closer than our candidate, so widen once to close the gap.
      if min > radius then
        search.radius = min
        local wider = surface.find_entities_filtered(search)
        if #wider > 0 then best, min = closest_of(wider, pos, entity_position) end
      end
      return best, min
    end
  end
  return nil, nil
end

-- Resolve the single entity a coordinate-addressed building command should act on.
-- Returns entity, nil  |  nil, error_table   (caller passes the error table to u.json_response)
--
-- Deliberately NOT find_nearest: that grows to a 200-tile radius for "nearest ore anywhere",
-- the opposite of "the entity at this exact coordinate".
--
-- opts: name, type, force (find_entities_filtered filters); radius (default 2); predicate
-- (function(e) -> boolean, applied after the engine filter); not_found (required error string);
-- reach (default true, checked against the RESOLVED entity, never the requested point);
-- reach_kind (passed to check_reach); allow_characters (default false).
function M.resolve_target(id, c, pos, opts)
  opts = opts or {}
  local radius = opts.radius or 2
  local search = {position = pos, radius = radius}
  if opts.name then search.name = opts.name end
  if opts.type then search.type = opts.type end
  if opts.force then search.force = opts.force end
  local es = c.entity.surface.find_entities_filtered(search)

  -- find_entities_filtered's order is the engine's own chunk order, not distance order -
  -- es[1] is an arbitrary member of the match set, not the nearest one.
  local best, min = nil, math.huge
  for _, e in ipairs(es) do
    if e.valid and e ~= c.entity
       and (opts.allow_characters or e.type ~= "character")
       and (not opts.predicate or opts.predicate(e)) then
      local d = M.distance(e.position, pos)
      if d < min then min, best = d, e end
    end
  end

  if not best then
    return nil, {id = id, error = opts.not_found, searched = {x = pos.x, y = pos.y}, radius = radius}
  end

  if opts.reach == nil or opts.reach then
    local err = M.check_reach(id, c, best.position, opts.reach_kind)
    if err then return nil, err end
  end

  return best, nil
end

-- Tile equivalent (water). Returns the tile's position (LuaTile has no stable handle worth
-- returning) and its distance, or nil.
function M.find_nearest_tile(surface, pos, names)
  for _, radius in ipairs(M.SEARCH_RADII) do
    local tiles = surface.find_tiles_filtered{position = pos, radius = radius, name = names}
    if #tiles > 0 then
      local best, min = closest_of(tiles, pos, tile_position)
      return best.position, min
    end
  end
  return nil, nil
end

-- Player-parity reach check. kind selects which of the companion's reach
-- properties (all read-only on LuaControl, inherited by character LuaEntity)
-- applies: "resource" for mining, "item" for ground item pickup, anything
-- else (default) for building/manipulation actions.
-- Returns nil when pos is in range, or a uniform machine-readable error table
-- when not, so the orchestrator can walk to `target` and retry.
-- Reach enforcement is always on, mirroring the same engine limits the human
-- player is subject to - there is no unrestricted/god-mode companion.
function M.check_reach(id, c, pos, kind)
  local limit
  if kind == "resource" then
    limit = c.entity.resource_reach_distance or 10
  elseif kind == "item" then
    limit = c.entity.item_pickup_distance or c.entity.reach_distance or 10
  else
    limit = c.entity.reach_distance or 10
  end
  local dist = M.distance(c.entity.position, pos)
  if dist > limit then
    return {
      id = id,
      error = "Too far",
      distance = math.floor(dist + 0.5),
      reach = math.floor(limit + 0.5),
      target = {x = pos.x, y = pos.y}
    }
  end
  return nil
end

function M.get_direction(from, to)
  local dx, dy = to.x - from.x, to.y - from.y
  if math.abs(dx) < 0.5 and math.abs(dy) < 0.5 then return nil end
  local deg = math.atan2(dy, dx) * 180 / math.pi
  if deg < 0 then deg = deg + 360 end
  local dirs = {
    {337.5, 22.5, defines.direction.east}, {22.5, 67.5, defines.direction.southeast},
    {67.5, 112.5, defines.direction.south}, {112.5, 157.5, defines.direction.southwest},
    {157.5, 202.5, defines.direction.west}, {202.5, 247.5, defines.direction.northwest},
    {247.5, 292.5, defines.direction.north}, {292.5, 337.5, defines.direction.northeast}
  }
  for _, d in ipairs(dirs) do
    if d[1] > d[2] then
      if deg >= d[1] or deg < d[2] then return d[3] end
    elseif deg >= d[1] and deg < d[2] then return d[3] end
  end
  return defines.direction.east
end

function M.render_label(entity, text, color)
  if not rendering then return nil end
  return rendering.draw_text{
    text = text, surface = entity.surface, target = entity,
    target_offset = {0, -2.5}, color = color, scale = 1.5, alignment = "center", use_rich_text = false
  }
end

-- ============ ARMING ============
-- Companions may only ever TAKE items that already exist in the world (a source inventory
-- passed in by the caller) - never conjured. See building.lua's insert-first idiom: an item
-- is only removed from the source once the target inventory has confirmed it accepted it.

local GUN_PREFERENCE = {"submachine-gun", "combat-shotgun", "shotgun", "pistol"}

-- Returns slot_index, gun_item_name for the first equipped gun slot, else nil.
function M.equipped_gun(entity)
  local inv = entity.get_inventory(defines.inventory.character_guns)
  if not inv then return nil end
  for i = 1, #inv do
    if inv[i].valid_for_read then return i, inv[i].name end
  end
  return nil
end

-- Returns slot_index, ammo_item_name for the first loaded ammo slot, else nil.
local function first_loaded_ammo(entity)
  local inv = entity.get_inventory(defines.inventory.character_ammo)
  if not inv then return nil end
  for i = 1, #inv do
    if inv[i].valid_for_read then return i, inv[i].name end
  end
  return nil
end

-- Total count across all loaded character_ammo slots.
function M.loaded_ammo_count(entity)
  local inv = entity.get_inventory(defines.inventory.character_ammo)
  if not inv then return 0 end
  local total = 0
  for i = 1, #inv do
    if inv[i].valid_for_read then total = total + inv[i].count end
  end
  return total
end

-- gun's compatible ammo categories as a set, e.g. {bullet = true}. get_ammo_type() returns
-- nil on ammo item prototypes here, so category matching must go through these two
-- prototype fields, NOT can_insert (which does not encode gun/ammo compatibility).
local function ammo_categories_for(gun_name)
  local proto = prototypes.item[gun_name]
  local cats = proto and proto.attack_parameters and proto.attack_parameters.ammo_categories
  local set = {}
  if cats then for _, cat in ipairs(cats) do set[cat] = true end end
  return set
end

local function find_matching_ammo(source_inv, cat_set)
  for _, item in ipairs(source_inv.get_contents()) do
    local proto = prototypes.item[item.name]
    if proto and proto.type == "ammo" and proto.ammo_category and cat_set[proto.ammo_category.name] then
      return item.name
    end
  end
  return nil
end

-- Arms entity from source_inv: equips a gun (if not already equipped) and loads matching
-- ammo, taking only items source_inv already has. Returns
-- {armed, weapon, ammo, ammo_count, reason} describing the entity's resulting state.
function M.arm_from(entity, source_inv)
  local guns = entity.get_inventory(defines.inventory.character_guns)
  local ammo_inv = entity.get_inventory(defines.inventory.character_ammo)
  if not guns or not ammo_inv or not source_inv then
    return {armed = false, ammo_count = 0, reason = "no gun available"}
  end

  local gun_slot, gun_name = M.equipped_gun(entity)

  if not gun_name then
    -- Candidate order: preference list first, then any other gun-type item present.
    local candidates, seen = {}, {}
    for _, g in ipairs(GUN_PREFERENCE) do candidates[#candidates + 1] = g; seen[g] = true end
    for _, item in ipairs(source_inv.get_contents()) do
      if not seen[item.name] then
        local proto = prototypes.item[item.name]
        if proto and proto.type == "gun" then candidates[#candidates + 1] = item.name; seen[item.name] = true end
      end
    end

    -- A gun is only eligible if source_inv also has matching ammo for it - otherwise an
    -- SMG with no ammo would win over a pistol the companion could actually fire.
    for _, g in ipairs(candidates) do
      if source_inv.get_item_count(g) > 0 then
        local cat_set = ammo_categories_for(g)
        if next(cat_set) and find_matching_ammo(source_inv, cat_set) then
          gun_name = g
          break
        end
      end
    end

    if not gun_name then return {armed = false, ammo_count = 0, reason = "no gun available"} end

    local ins = guns.insert{name = gun_name, count = 1}
    if ins < 1 then return {armed = false, ammo_count = 0, reason = "no gun available"} end
    source_inv.remove{name = gun_name, count = ins}
    gun_slot = M.equipped_gun(entity)
  end

  local cat_set = ammo_categories_for(gun_name)
  local ammo_name = find_matching_ammo(source_inv, cat_set)
  if ammo_name then
    local available = source_inv.get_item_count(ammo_name)
    local stack_size = prototypes.item[ammo_name].stack_size or available
    local want = math.min(available, stack_size)
    local ins_ammo = ammo_inv.insert{name = ammo_name, count = want}
    if ins_ammo > 0 then source_inv.remove{name = ammo_name, count = ins_ammo} end
  end

  if gun_slot then entity.selected_gun_index = gun_slot end

  local final_ammo_count = M.loaded_ammo_count(entity)
  if final_ammo_count < 1 then
    return {armed = false, weapon = gun_name, ammo_count = 0, reason = "no ammo for " .. gun_name}
  end
  local _, final_ammo_name = first_loaded_ammo(entity)
  return {armed = true, weapon = gun_name, ammo = final_ammo_name, ammo_count = final_ammo_count}
end

-- Spills one inventory's full contents onto the ground - the disappear/kill idiom for
-- returning items the companion held rather than destroying them.
function M.spill_inventory(entity, inv_type)
  local dropped = {}
  local inv = entity.get_inventory(inv_type)
  if inv then
    local pos, surf = entity.position, entity.surface
    for _, item in pairs(inv.get_contents()) do
      surf.spill_item_stack{
        position = pos,
        stack = {name = item.name, count = item.count, quality = item.quality},
        enable_looted = true,
        allow_belts = false
      }
      dropped[#dropped + 1] = {name = item.name, count = item.count}
    end
  end
  return dropped
end

-- Companions now carry the player's real gun/ammo (see arm_from) - despawn paths must
-- spill these too, or destroying/disappearing a companion destroys real player items.
function M.spill_equipment(entity)
  local dropped = {}
  for _, d in ipairs(M.spill_inventory(entity, defines.inventory.character_guns)) do dropped[#dropped + 1] = d end
  for _, d in ipairs(M.spill_inventory(entity, defines.inventory.character_ammo)) do dropped[#dropped + 1] = d end
  return dropped
end

return M
