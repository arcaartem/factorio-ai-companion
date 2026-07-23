-- AI Companion v0.9.0
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

-- Player-parity reach check. kind selects which of the companion's reach
-- properties (all read-only on LuaControl, inherited by character LuaEntity)
-- applies: "resource" for mining, "item" for ground item pickup, anything
-- else (default) for building/manipulation actions.
-- Returns nil when pos is in range, or a uniform machine-readable error table
-- when not, so the orchestrator can walk to `target` and retry.
-- Reach enforcement is opt-in per companion via c.realistic (default/nil/false
-- = unrestricted, act at any range).
function M.check_reach(id, c, pos, kind)
  if not c.realistic then return nil end
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

return M
