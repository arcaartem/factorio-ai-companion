# Publishing to Factorio Mod Portal

## Prerequisites

1. **Create account**: Go to https://mods.factorio.com/ and create an account
2. **Link Steam/Factorio account**: Required for mod publishing

## Files Prepared

✅ `factorio-mod/info.json` - Mod metadata (v0.13.0)
✅ `factorio-mod/changelog.txt` - Version history
✅ `ai-companion_0.13.0.zip` - Packaged mod ready to upload

⚠️ **Missing**: `thumbnail.png` (optional but recommended)
   - Recommended size: 144x144 pixels
   - Should show an AI companion or robot
   - Place in `factorio-mod/thumbnail.png`

## Publishing Steps

### 1. Login to Mod Portal
Go to: https://mods.factorio.com/login

### 2. Create New Mod
- Click **"Publish new mod"**
- Upload: `ai-companion_0.13.0.zip`

### 3. Fill in Details
**Name:** `ai-companion` (must match `info.json`)

**Title:** `AI Companion`

**Summary:**
```
AI companions for Factorio 2.x controlled via RCON. Features 51 commands, autonomous mining, hybrid native API, and Claude Code integration.
```

**Description (Markdown):**
```markdown
# AI Companion

Control AI companions in Factorio 2.x using natural language through Claude Code and RCON.

## Features
- **53 RCON Commands**: Complete API for AI control
- **Autonomous Skills**: Mining, building, combat
- **Hybrid Mining**: Native Factorio API + auto-restart
- **Map Markers**: Track companions on the map
- **MCP Integration**: Works with Claude Code/Claude Desktop

## Quick Start

1. Enable RCON in `config.ini`:
   ```ini
   [network]
   local-rcon-socket=127.0.0.1:34198
   local-rcon-password=factorio
   ```

2. Start Factorio in multiplayer mode

3. Use `/fac` commands in-game or connect via Claude Code

## Commands
- `/fac spawn [n]` - Spawn companions
- `/fac list` - List all companions
- `/fac <id> <message>` - Send command to companion

## External Control

See [GitHub repository](https://github.com/lveillard/factorio-ai-companion) for TypeScript/Node.js client and Claude Code integration.

## Requirements
- Factorio 2.0+
- Multiplayer mode (RCON)
```

**Tags:** `ai`, `rcon`, `automation`, `companions`, `mcp`

**License:** MIT

**Homepage:** `https://github.com/lveillard/factorio-ai-companion`

**Source:** `https://github.com/lveillard/factorio-ai-companion`

### 4. Submit

Click **"Create"** and your mod will be published!

## Updating Later

1. Update `info.json` version
2. Update `changelog.txt`
3. Create new zip: `ai-companion_X.Y.Z.zip`
4. Go to mod page → **"Upload new version"**

## Post-Publishing

Your mod will be available at:
`https://mods.factorio.com/mod/ai-companion`

Players can download via:
- In-game mod browser
- Factorio Mod Portal website
- Direct download link
