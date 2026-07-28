-- AI Companion v0.9.0 - Building commands
local u = require("commands.init")
local queues = require("commands.queues")

commands.add_command("fac_building_can_place", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s+([%d.-]+)%s+([%d.-]+)%s*(%d*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local name, x, y = args[2], tonumber(args[3]), tonumber(args[4])
    local dir = u.dir_map[tonumber(args[5]) or 0] or defines.direction.north
    if not x or not y then u.error_response("Invalid coordinates"); return end
    local reach_err = u.check_reach(id, c, {x=x, y=y})
    if reach_err then u.json_response(reach_err); return end
    local inv = c.entity.get_inventory(defines.inventory.character_main)
    if inv.get_item_count(name) == 0 then u.json_response({id = id, can_place = false, reason = "Not in inventory"}); return end
    local can = c.entity.surface.can_place_entity{name = name, position = {x=x, y=y}, direction = dir, force = c.entity.force}
    u.json_response({id = id, can_place = can, entity = name})
  end)
end)

commands.add_command("fac_building_place", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s+([%d.-]+)%s+([%d.-]+)%s*(%d*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local name, x, y = args[2], tonumber(args[3]), tonumber(args[4])
    local dir = u.dir_map[tonumber(args[5]) or 0] or defines.direction.north
    if not x or not y then u.error_response("Invalid coordinates"); return end
    local reach_err = u.check_reach(id, c, {x=x, y=y})
    if reach_err then u.json_response(reach_err); return end
    local inv = c.entity.get_inventory(defines.inventory.character_main)
    if inv.get_item_count(name) == 0 then u.json_response({id = id, error = "Not in inventory"}); return end
    local surf = c.entity.surface
    if not surf.can_place_entity{name = name, position = {x=x, y=y}, direction = dir, force = c.entity.force} then
      u.json_response({id = id, error = "Cannot place"}); return
    end
    local e = surf.create_entity{name = name, position = {x=x, y=y}, direction = dir, force = c.entity.force}
    if e then
      inv.remove{name = name, count = 1}
      u.json_response({id = id, placed = true, entity = name,
        position = {x = e.position.x, y = e.position.y}, direction = e.direction})
    else u.json_response({id = id, error = "Failed"}) end
  end)
end)

commands.add_command("fac_building_remove", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s+([%d.-]+)%s+([%d.-]+)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local name, x, y = args[2], tonumber(args[3]), tonumber(args[4])
    if not x or not y then u.error_response("Invalid coordinates"); return end
    -- radius 2, not 1: entities can snap to a grid position the caller didn't request
    local t, err = u.resolve_target(id, c, {x=x, y=y}, {
      name = name, force = c.entity.force, radius = 2, not_found = "Not found"
    })
    if not t then u.json_response(err); return end
    local pos = {x = t.position.x, y = t.position.y}
    if t.can_be_destroyed() then
      -- only destroy once the companion has actually taken the item, else it is lost
      if c.entity.insert{name = name, count = 1} < 1 then
        u.json_response({id = id, error = "Inventory full", full = true}); return
      end
      t.destroy{raise_destroy = false}
      u.json_response({id = id, removed = true, entity = name, position = pos})
    else u.json_response({id = id, error = "Cannot remove"}) end
  end)
end)

commands.add_command("fac_building_rotate", nil, function(cmd)
  u.safe_command(function()
    -- (%d+), not (%d): a multi-digit direction must be captured whole so it can be
    -- REJECTED below, rather than silently truncated to its first digit.
    local args = u.parse_args("^(%S+)%s+([%d.-]+)%s+([%d.-]+)%s+(%d+)%s*(%S*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local x, y, dir = tonumber(args[2]), tonumber(args[3]), tonumber(args[4])
    local entity_name = args[5] ~= "" and args[5] or nil
    if not x or not y then u.error_response("Invalid coordinates"); return end
    if not dir or dir < 0 or dir > 3 then
      u.json_response({id = id, error = "Invalid direction", direction = dir, valid = "0-3"}); return
    end
    local t, err = u.resolve_target(id, c, {x=x, y=y}, {
      name = entity_name, force = c.entity.force, radius = 1,
      predicate = function(e) return e.rotatable end,
      not_found = "No rotatable entity"
    })
    if not t then u.json_response(err); return end
    if not prototypes.entity[t.name].supports_direction then
      u.json_response({id = id, error = "Entity does not support direction", entity = t.name}); return
    end
    local want = u.dir_map[dir]
    t.direction = want
    local after = t.direction
    local pos = {x = t.position.x, y = t.position.y}
    if after == want then
      u.json_response({id = id, rotated = true, entity = t.name, direction = after,
        direction_index = dir, position = pos})
    else
      u.json_response({id = id, error = "Rotate had no effect", entity = t.name,
        direction = after, requested = want, direction_index = dir, position = pos})
    end
  end)
end)

commands.add_command("fac_building_info", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s+([%d.-]+)%s+([%d.-]+)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local name, x, y = args[2], tonumber(args[3]), tonumber(args[4])
    if not x or not y then u.error_response("Invalid coordinates"); return end
    -- read-only inspection: no reach check, deliberately
    local t, err = u.resolve_target(id, c, {x=x, y=y}, {
      name = name, radius = 2, reach = false, not_found = "Not found"
    })
    if not t then u.json_response(err); return end
    local info = {name = t.name, type = t.type, position = {x = t.position.x, y = t.position.y}, direction = t.direction}
    if t.health then info.health = t.health end
    if t.energy then info.energy = t.energy end
    -- get_recipe exists on every LuaEntity but raises on non-crafting machines, so gate on type
    if t.type == "assembling-machine" or t.type == "furnace" or t.type == "rocket-silo" then
      local r = t.get_recipe(); if r then info.recipe = r.name end
    end
    u.json_response({id = id, entity = info})
  end)
end)

commands.add_command("fac_building_recipe", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s+([%d.-]+)%s+([%d.-]+)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local recipe, x, y = args[2], tonumber(args[3]), tonumber(args[4])
    if not x or not y then u.error_response("Invalid coordinates"); return end
    local t, err = u.resolve_target(id, c, {x=x, y=y}, {
      type = "assembling-machine", radius = 1, not_found = "No machine"
    })
    if not t then u.json_response(err); return end
    if not c.entity.force.recipes[recipe] then u.json_response({id = id, error = "Recipe not found"}); return end
    t.set_recipe(recipe)
    u.json_response({id = id, set_recipe = true, recipe = recipe, entity = t.name,
      position = {x = t.position.x, y = t.position.y}})
  end)
end)

commands.add_command("fac_building_fuel", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s*(%d*)%s*([%d.-]*)%s*([%d.-]*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local fuel, amount = args[2], tonumber(args[3]) or 5
    local explicit_pos = tonumber(args[4]) and tonumber(args[5])
    local pos = explicit_pos and {x = tonumber(args[4]), y = tonumber(args[5])} or c.entity.position
    local inv = c.entity.get_inventory(defines.inventory.character_main)
    local have = inv.get_item_count(fuel)
    if have == 0 then u.json_response({id = id, error = "No " .. fuel}); return end
    -- burner-inserter's PROTOTYPE TYPE is "inserter", not "burner-inserter" - the old filter
    -- entry never matched anything, so burner inserters were unfuellable
    local t, err = u.resolve_target(id, c, pos, {
      type = {"furnace", "boiler", "inserter", "car", "locomotive", "mining-drill"},
      radius = 3,
      predicate = function(e) return e.get_fuel_inventory() ~= nil end,
      not_found = "No burner nearby"
    })
    if not t then u.json_response(err); return end
    local fi = t.get_fuel_inventory()
    local ins = fi.insert{name = fuel, count = math.min(amount, have)}
    if ins > 0 then
      inv.remove{name = fuel, count = ins}
      u.json_response({id = id, inserted = ins, fuel = fuel, entity = t.name,
        position = {x = t.position.x, y = t.position.y}})
    else u.json_response({id = id, error = "Full"}) end
  end)
end)

commands.add_command("fac_building_empty", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s*(%d*)%s*([%d.-]*)%s*([%d.-]*)%s*(%S*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local item, count = args[2], tonumber(args[3]) or 10
    if not count or count <= 0 then
      u.json_response({id = id, error = "count must be positive"}); return
    end
    local explicit_pos = tonumber(args[4]) and tonumber(args[5])
    local pos = explicit_pos and {x = tonumber(args[4]), y = tonumber(args[5])} or c.entity.position
    local entity_name = args[6] ~= "" and args[6] or nil
    -- include neutral so crash-site wreckage and other unowned containers are reachable;
    -- excluding characters (resolve_target's default) closes the hole where an unrestricted
    -- radius-5 search could drain the player's own main inventory
    local t, err = u.resolve_target(id, c, pos, {
      name = entity_name, force = {c.entity.force, "neutral"}, radius = 3, not_found = "Not found"
    })
    if not t then u.json_response(err); return end

    -- defines.inventory.{chest, furnace_result, assembling_machine_output} are {1, 3, 3} -
    -- index 3 is aliased twice, so a plain loop over that list visits it a second time after
    -- the request is already satisfied and calls insert{count = 0}, which raises. De-dup first.
    local seen, inv_indices = {}, {}
    for _, it in ipairs({defines.inventory.chest, defines.inventory.furnace_result, defines.inventory.assembling_machine_output}) do
      if not seen[it] then seen[it] = true; inv_indices[#inv_indices + 1] = it end
    end

    local ext = 0
    -- ext is an upvalue: even if this raises partway through, whatever was already
    -- transferred before the failing statement stays counted below, rather than lost.
    local ok, transfer_err = pcall(function()
      for _, it in ipairs(inv_indices) do
        local inv = t.get_inventory(it)
        if inv then
          local av = inv.get_item_count(item)
          if av > 0 then
            local want = math.min(count - ext, av)
            if want <= 0 then break end
            -- insert first and remove only what the companion accepted, else the
            -- shortfall is destroyed outright when its inventory is full
            local acc = c.entity.insert{name = item, count = want}
            if acc > 0 then inv.remove{name = item, count = acc}; ext = ext + acc end
          end
        end
        if ext >= count then break end
      end
    end)

    local result = {id = id, extracted = ext, item = item, entity = t.name,
      position = {x = t.position.x, y = t.position.y}}
    if not ok then result.error = tostring(transfer_err) end
    u.json_response(result)
  end)
end)

commands.add_command("fac_building_fill", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s*(%d*)%s*([%d.-]*)%s*([%d.-]*)%s*(%S*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local item, count = args[2], tonumber(args[3]) or 10
    -- same trap as building_empty: 0 is truthy in Lua so it survives `tonumber(...) or 10`, and
    -- insert{count = 0} raises "count must be positive" rather than being a no-op
    if not count or count <= 0 then
      u.json_response({id = id, error = "count must be positive"}); return
    end
    local explicit_pos = tonumber(args[4]) and tonumber(args[5])
    local pos = explicit_pos and {x = tonumber(args[4]), y = tonumber(args[5])} or c.entity.position
    local entity_name = args[6] ~= "" and args[6] or nil
    local inv = c.entity.get_inventory(defines.inventory.character_main)
    local have = inv.get_item_count(item)
    if have == 0 then u.json_response({id = id, error = "No " .. item}); return end
    local t, err = u.resolve_target(id, c, pos, {
      name = entity_name, force = c.entity.force, radius = 3, not_found = "Could not insert"
    })
    if not t then u.json_response(err); return end
    local ins = t.insert{name = item, count = math.min(count, have)}
    if ins > 0 then
      inv.remove{name = item, count = ins}
      u.json_response({id = id, inserted = ins, item = item, entity = t.name,
        position = {x = t.position.x, y = t.position.y}})
    else u.json_response({id = id, error = "Could not insert"}) end
  end)
end)

-- Realistic tick-based building placement
commands.add_command("fac_building_place_start", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)%s+(%-?%d+%.?%d*)%s+(%-?%d+%.?%d*)%s*(%S*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local entity = args[2]
    local x, y = tonumber(args[3]), tonumber(args[4])
    local dir = u.dir_map[tonumber(args[5]) or 0] or defines.direction.north
    local result = queues.start_build(id, entity, {x = x, y = y}, dir)
    result.id = id
    u.json_response(result)
  end)
end)

commands.add_command("fac_building_place_status", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)$", cmd.parameter)
    local id = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local status = queues.get_build_status(id)
    u.json_response({id = id, status = status})
  end)
end)
