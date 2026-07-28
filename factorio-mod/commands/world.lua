-- AI Companion v0.7.0 - World commands
local u = require("commands.init")

commands.add_command("fac_world_nearest", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local what = args[2]
    local pos = c.entity.position
    local surf = c.entity.surface
    -- Same limited-scan defect resource_nearest had: a flat limit=100 over a +/-200 square
    -- returns an arbitrary slice, so the true nearest can be excluded outright. u.find_nearest
    -- grows an unlimited circle instead, which is complete by construction.
    if what == "water" then
      local wpos, wmin = u.find_nearest_tile(surf, pos, {"water", "deepwater"})
      if not wpos then u.json_response({id = id, error = "Not found"}); return end
      u.json_response({id = id, nearest = "water", position = wpos, distance = wmin}); return
    end
    local closest, min = u.find_nearest(surf, pos, u.resource_filter(what))
    if not closest then u.json_response({id = id, error = "Not found"}); return end
    u.json_response({id = id, nearest = closest.name, position = {x = closest.position.x, y = closest.position.y}, distance = min})
  end)
end)

commands.add_command("fac_world_scan", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s*(%d*)%s*(%S*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local radius = tonumber(args[2]) or 10
    local filter = args[3] ~= "" and args[3] or nil
    local search = {position = c.entity.position, radius = radius}
    if filter then search.name = filter end
    local es = c.entity.surface.find_entities_filtered(search)
    local result = {}
    for _, e in ipairs(es) do
      if e.valid and e ~= c.entity then
        local r = {name = e.name, type = e.type, position = {x = e.position.x, y = e.position.y}}
        if e.health then r.health = e.health end
        result[#result + 1] = r
      end
    end
    if #result > 50 then local t = {}; for i = 1, 50 do t[i] = result[i] end; result = t end
    u.json_response({id = id, entities = result, count = #result})
  end)
end)
