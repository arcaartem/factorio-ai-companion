-- AI Companion - Help
local u = require("commands.init")

-- Version command
commands.add_command("fac_version", nil, function()
  local version = script.active_mods["ai-companion"] or "unknown"
  u.json_response({version = version, factorio = script.active_mods["base"] or "unknown"})
  game.print("[AI Companion] v" .. version, u.print_color(u.COLORS.system))
end)

commands.add_command("fac_help", nil, function()
  local version = script.active_mods["ai-companion"] or "unknown"
  u.json_response({
    version = version,
    commands = 51,
    categories = {"action", "building", "chat", "companion", "context", "item", "move", "research", "resource", "world"},
    action = {"attack", "flee", "patrol"},
    building = {"can_place", "empty", "fill", "fuel", "info", "place", "recipe", "remove", "rotate"},
    chat = {"get", "say"},
    companion = {"disappear", "health", "inventory", "position", "spawn"},
    context = {"clear", "check"},
    item = {"craft", "pick", "recipes"},
    move = {"follow", "stop", "to"},
    research = {"get", "progress", "set"},
    resource = {"list", "mine", "nearest"},
    world = {"nearest", "scan"},
    player = {"/fac <msg>", "/fac <id> <msg>", "/fac spawn", "/fac list", "/fac kill", "/fac clear", "/fac name"}
  })
end)
