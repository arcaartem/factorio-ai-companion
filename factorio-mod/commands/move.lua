-- AI Companion - Move commands
-- Movement is driven by LuaSurface::request_path (real pathfinding, not a straight-line
-- bearing walk). request_path is asynchronous, so these commands only kick off/cancel/poll
-- the walk; the actual path-following and arrival/stuck detection lives in queues.lua's
-- tick_walk_queues, which fac_companion_stop_all and fac_companion_disappear (companion.lua)
-- also rely on via storage.walking_queues.
local u = require("commands.init")
local queues = require("commands.queues")

commands.add_command("fac_move_to", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+([%d.-]+)%s+([%d.-]+)$", cmd.parameter)
    local id = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local x, y = tonumber(args[2]), tonumber(args[3])
    if not x or not y then u.error_response("Invalid coordinates"); return end
    -- Calling this again with the same (x, y) while already requesting/walking is how the
    -- orchestrator polls arrival status - see queues.start_walk's idempotent check.
    local result = queues.start_walk(id, {x = x, y = y})
    result.id = id
    u.json_response(result)
  end)
end)

commands.add_command("fac_move_follow", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(.+)$", cmd.parameter)
    local id = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local pname = args[2]
    if not game.get_player(pname) then u.error_response("Player not found"); return end
    local result = queues.start_follow(id, pname)
    result.id = id
    u.json_response(result)
  end)
end)

commands.add_command("fac_move_stop", nil, function(cmd)
  u.safe_command(function()
    local id = u.find_companion(cmd.parameter)
    if not id then u.error_response("Companion not found"); return end
    local result = queues.stop_walk(id)
    result.id = id
    u.json_response(result)
  end)
end)
