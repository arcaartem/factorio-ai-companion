-- AI Companion v0.9.0 - Resource commands
local u = require("commands.init")
local queues = require("commands.queues")

-- Resource name aliases and the ore-vs-tree filter split live in commands.init so the harvest
-- queue resolves a token exactly the way these commands do.

commands.add_command("fac_resource_list", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s*(%S*)%s*(%d*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local filter = args[2] ~= "" and args[2] or nil
    local radius = tonumber(args[3]) or 50
    local pos = c.entity.position
    local res = c.entity.surface.find_entities_filtered{type = "resource", position = pos, radius = radius, limit = 20}
    local found = {}
    for _, r in ipairs(res) do
      if not filter or r.name == filter then
        found[#found + 1] = {name = r.name, position = {x = math.floor(r.position.x), y = math.floor(r.position.y)}, amount = r.amount, distance = math.floor(u.distance(pos, r.position))}
      end
    end
    table.sort(found, function(a, b) return a.distance < b.distance end)
    u.json_response({id = id, resources = found, count = #found})
  end)
end)

-- Realistic mining using tick-based queue system
-- Usage: /fac_resource_mine <id> <x> <y> [count] [resource_name]
-- resource_name is optional - if provided, only mines that specific resource type
commands.add_command("fac_resource_mine", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%-?%d+%.?%d*)%s+(%-?%d+%.?%d*)%s*(%d*)%s*(%S*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local x, y, count = tonumber(args[2]), tonumber(args[3]), tonumber(args[4]) or 1
    local resource_name = args[5] ~= "" and args[5] or nil
    -- Normalize common resource names ("wood"/"tree" pass through - start_harvest resolves
    -- them to a type filter, since trees have no single prototype name to match on).
    if resource_name and not u.is_wood(resource_name) then
      resource_name = u.normalize_resource(resource_name)
    end
    if not x or not y then u.error_response("Invalid coordinates"); return end
    local tpos = {x = x, y = y}
    local reach_err = u.check_reach(id, c, tpos, "resource")
    if reach_err then u.json_response(reach_err); return end
    -- Start realistic mining via queue system (with optional resource filter)
    local result = queues.start_harvest(id, tpos, count, resource_name)
    -- start_harvest always returns a table, including on its failure paths (e.g. "No
    -- resource") - reporting the hardcoded success shape regardless made a failed start
    -- look identical to a started one to callers gating on mining === true.
    if result.error then
      u.json_response({id = id, error = result.error})
    else
      u.json_response({id = id, mining = true, target = count, entities = result.entities or 0, resource = resource_name, status = "started"})
    end
  end)
end)

-- Check mining status
commands.add_command("fac_resource_mine_status", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)$", cmd.parameter)
    local id = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local status = queues.get_harvest_status(id)
    u.json_response({id = id, status = status})
  end)
end)

-- Stop mining
commands.add_command("fac_resource_mine_stop", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)$", cmd.parameter)
    local id = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local result = queues.stop_harvest(id)
    u.json_response({id = id, stopped = result.stopped, harvested = result.harvested or 0})
  end)
end)

commands.add_command("fac_resource_nearest", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local pos = c.entity.position
    local closest, min = u.find_nearest(c.entity.surface, pos, u.resource_filter(args[2]))
    if not closest then u.json_response({id = id, error = "Not found"}); return end
    -- Exact position, not math.floor'd. Ore sits at tile CENTRES (x.5, y.5), so flooring moved
    -- the reported target ~0.71 tiles off the entity - which callers then spend out of the
    -- engine's 2.7-tile resource_reach_distance before they have walked anywhere.
    -- `amount` is a resource-only property; reading it off a tree raises, so it is reported
    -- only for the entities that actually carry one.
    u.json_response({
      id = id,
      resource = closest.name,
      position = {x = closest.position.x, y = closest.position.y},
      distance = min,
      amount = closest.type == "resource" and closest.amount or nil
    })
  end)
end)
