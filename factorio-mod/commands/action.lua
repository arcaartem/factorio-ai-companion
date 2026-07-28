-- AI Companion v0.7.0 - Action commands
local u = require("commands.init")

commands.add_command("fac_action_attack", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+([%d.-]+)%s+([%d.-]+)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local x, y = tonumber(args[2]), tonumber(args[3])
    if not x or not y then u.error_response("Invalid coordinates"); return end
    local target_pos = {x = x, y = y}

    -- Bind the AIM POINT, not firing itself - actual damage is separately engine-gated by
    -- weapon range, same as queues.start_combat. A companion may not designate a target at
    -- arbitrary map coordinates.
    local reach_err = u.check_reach(id, c, target_pos)
    if reach_err then
      reach_err.attacking = false
      u.json_response(reach_err)
      return
    end

    -- Same weapon/ammo gate as queues.start_combat - report a truthful attacking = false
    -- instead of latching shooting_state with nothing able to fire.
    u.arm_from(c.entity, c.entity.get_main_inventory())
    if not u.equipped_gun(c.entity) then
      u.json_response({id = id, attacking = false, error = "No weapon equipped"}); return
    end
    if u.loaded_ammo_count(c.entity) < 1 then
      u.json_response({id = id, attacking = false, error = "No ammo"}); return
    end

    -- STOP WALKING - Clear walking queue so attack can take priority
    storage.walking_queues[id] = nil
    c.entity.walking_state = {walking = false}

    -- Nearest hostile, not the arbitrary chunk-order es[1] the old find_entities_filtered
    -- call returned (which admitted trees, rocks and the player's own buildings). reach =
    -- false: designation range was already bound against target_pos above, not the resolved
    -- entity's own position.
    local target = u.resolve_target(id, c, target_pos, {
      type = {"unit", "unit-spawner"}, force = "enemy", radius = 2,
      not_found = "No enemy nearby", reach = false
    })
    if target then
      c.entity.shooting_state = {state = defines.shooting.shooting_enemies, position = target.position}
      u.json_response({id = id, attacking = true, target = target.name, position = {x = target.position.x, y = target.position.y}})
    else
      -- Deliberate ground-fire fallback when no enemy resolves nearby.
      c.entity.shooting_state = {state = defines.shooting.shooting_enemies, position = target_pos}
      u.json_response({id = id, attacking = true, target = "ground", position = target_pos})
    end
  end)
end)

commands.add_command("fac_action_flee", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s*(%d*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local dist = tonumber(args[2]) or 30
    local pos = c.entity.position
    local enemies = c.entity.surface.find_entities_filtered{type = {"unit", "unit-spawner", "turret"}, position = pos, radius = 50, force = "enemy", limit = 5}
    if #enemies == 0 then u.json_response({id = id, fleeing = false, message = "No enemies"}); return end
    local ax, ay = 0, 0
    for _, e in ipairs(enemies) do ax, ay = ax + e.position.x, ay + e.position.y end
    ax, ay = ax / #enemies, ay / #enemies
    local dx, dy = pos.x - ax, pos.y - ay
    local len = math.sqrt(dx*dx + dy*dy)
    if len > 0 then dx, dy = dx / len * dist, dy / len * dist else dx = dist end
    local flee_pos = {x = pos.x + dx, y = pos.y + dy}
    storage.walking_queues[id] = {target = flee_pos}
    u.json_response({id = id, fleeing = true, enemies = #enemies, to = flee_pos})
  end)
end)

commands.add_command("fac_action_patrol", nil, function(cmd)
  u.safe_command(function()
    local id = u.find_companion(cmd.parameter)
    if not id then u.error_response("Companion not found"); return end
    u.json_response({id = id, error = "Not implemented"})
  end)
end)

