-- AI Companion v0.7.0 - Research commands
local u = require("commands.init")

-- Position of `name` in force.research_queue (1 = current), or nil if absent.
local function queue_position(force, name)
  for i, t in ipairs(force.research_queue) do
    if t.name == name then return i end
  end
  return nil
end

commands.add_command("fac_research_get", nil, function(cmd)
  u.safe_command(function()
    local id, c = u.find_companion(cmd.parameter)
    if not id then u.error_response("Companion not found"); return end
    local force = c.entity.force
    local current = force.current_research and {name = force.current_research.name, progress = force.research_progress} or nil
    local available = {}
    for name, tech in pairs(force.technologies) do
      if not tech.researched and tech.enabled then
        local can = true
        for _, p in pairs(tech.prerequisites) do if not p.researched then can = false; break end end
        if can then
          local ings = {}
          for _, ing in pairs(tech.research_unit_ingredients) do ings[#ings + 1] = ing.name end
          available[#available + 1] = {name = name, units = tech.research_unit_count, ingredients = ings}
        end
      end
    end
    table.sort(available, function(a, b) return a.units < b.units end)
    if #available > 30 then local t = {}; for i = 1, 30 do t[i] = available[i] end; available = t end
    local queue = {}
    for i, t in ipairs(force.research_queue) do
      queue[i] = {name = t.name, units = t.research_unit_count}
    end
    u.json_response({id = id, current = current, available = available, count = #available,
      queue = queue, queue_count = #force.research_queue})
  end)
end)

commands.add_command("fac_research_progress", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s*(%S*)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local force = c.entity.force
    local tech_name = args[2] ~= "" and args[2] or (force.current_research and force.current_research.name)
    if not tech_name then u.json_response({id = id, researching = nil}); return end
    local tech = force.technologies[tech_name]
    if not tech then u.json_response({id = id, error = "Not found"}); return end
    if tech.researched then u.json_response({id = id, tech = tech_name, done = true}); return end
    local is_cur = force.current_research and force.current_research.name == tech_name
    local prog = is_cur and force.research_progress or 0
    u.json_response({id = id, tech = tech_name, progress = prog, remaining = math.ceil(tech.research_unit_count * (1 - prog))})
  end)
end)

-- add_research() APPENDS to the research queue rather than preempting it - see the T-055 note
-- in CLAUDE.md. So its own boolean return says nothing about whether `name` became the current
-- research; the queue must be read back afterwards to tell "researching" from merely "queued".
commands.add_command("fac_research_set", nil, function(cmd)
  u.safe_command(function()
    local args = u.parse_args("^(%S+)%s+(%S+)$", cmd.parameter)
    local id, c = u.find_companion(args[1])
    if not id then u.error_response("Companion not found"); return end
    local force = c.entity.force
    local tech = force.technologies[args[2]]
    if not tech then u.json_response({id = id, error = "Not found"}); return end
    if tech.researched then u.json_response({id = id, error = "Already done"}); return end
    for _, p in pairs(tech.prerequisites) do if not p.researched then u.json_response({id = id, error = "Missing: " .. p.name}); return end end

    -- add_research returns false both when `name` is already queued (queue left unchanged, not
    -- an error) and when it's already researched (excluded above already) - so the queue itself,
    -- not this return value, is what decides the reply.
    local added = force.add_research(args[2])
    local pos = queue_position(force, args[2])
    if not pos then u.json_response({id = id, error = "Failed"}); return end

    if pos == 1 then
      u.json_response({id = id, researching = args[2], position = 1})
    else
      local resp = {id = id, queued = args[2], position = pos,
        current = force.current_research and force.current_research.name}
      if not added then resp.already_queued = true end
      u.json_response(resp)
    end
  end)
end)
