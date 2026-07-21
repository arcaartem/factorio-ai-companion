#!/usr/bin/env bun
/**
 * Validate MCP tools match Lua commands 1:1
 * Run: bun run scripts/validate-tools.ts
 */

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { TOOLS, SKILLS } from "../src/mcp/tools";

const LUA_COMMANDS_DIR = "factorio-mod/commands";

async function extractLuaCommands(): Promise<Set<string>> {
  const commands = new Set<string>();
  const files = await readdir(LUA_COMMANDS_DIR);

  for (const file of files) {
    if (!file.endsWith(".lua")) continue;
    const content = await readFile(join(LUA_COMMANDS_DIR, file), "utf-8");

    // Match: commands.add_command("fac_xxx", ...)
    const matches = content.matchAll(/commands\.add_command\s*\(\s*"(fac_[^"]+)"/g);
    for (const match of matches) {
      commands.add(match[1]!);
    }
  }

  return commands;
}

// --- Arity/order validation -------------------------------------------------
//
// Each Lua command optionally parses its RCON parameter string with
// `u.parse_args("<pattern>", cmd.parameter)`, an anchored Lua pattern where
// every `(...)` is a capture group corresponding 1:1 to a positional argument.
// The TS side builds the RCON command by substituting `{name}` placeholders
// into a template string, in a fixed left-to-right order. If the number or
// order of TS placeholders doesn't line up with the Lua pattern's capture
// groups, `parse_args` either fails to match (empty args -> "Companion not
// found") or silently binds the wrong value to the wrong slot.
//
// This section extracts, per Lua command, the pattern string used, and
// per MCP tool, the ordered list of placeholders + their declared type, then
// cross-checks arity (accounting for optional/star captures) and, where it's
// cheaply decidable, positional type compatibility.

interface CaptureSpec {
  raw: string;
  optional: boolean; // capture group can match the empty string
  numericOnly: boolean; // capture group's pattern only ever matches digits/./-
}

interface PatternToken {
  item: string;
  quant: string | null; // '*' | '-' | '?' | '+' | null
}

function tokenizeGroup(content: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  let i = 0;
  while (i < content.length) {
    let itemLen: number;
    if (content[i] === "%") {
      itemLen = 2; // Lua class escape, e.g. %S, %d, %-, %.
    } else if (content[i] === "[") {
      const close = content.indexOf("]", i + 1);
      itemLen = close === -1 ? content.length - i : close - i + 1;
    } else {
      itemLen = 1; // literal char or '.' (any-char magic)
    }
    const item = content.slice(i, i + itemLen);
    const q = content[i + itemLen];
    const quant = q === "*" || q === "-" || q === "?" || q === "+" ? q : null;
    tokens.push({ item, quant });
    i += itemLen + (quant ? 1 : 0);
  }
  return tokens;
}

function isNumericItem(item: string): boolean {
  if (item === "%d" || item === "%-" || item === "%.") return true;
  if (item.startsWith("[") && item.endsWith("]")) {
    const inner = item.slice(1, -1).replace(/%d/g, "");
    return /^[.\-]*$/.test(inner);
  }
  return false;
}

function classifyCaptureGroup(raw: string): CaptureSpec {
  const tokens = tokenizeGroup(raw);
  const optional = tokens.length > 0 && tokens.every((t) => t.quant === "*" || t.quant === "-" || t.quant === "?");
  const numericOnly = tokens.length > 0 && tokens.every((t) => isNumericItem(t.item));
  return { raw, optional, numericOnly };
}

// Extract the raw text of each top-level `(...)` capture group in an anchored
// Lua pattern, respecting `%(`/`%)` escapes (which are literal chars, not
// group delimiters).
function extractCaptureGroups(pattern: string): string[] {
  const groups: string[] = [];
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === "%") {
      i += 2;
      continue;
    }
    if (pattern[i] === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < pattern.length && depth > 0) {
        if (pattern[j] === "%") {
          j += 2;
          continue;
        }
        if (pattern[j] === "(") depth++;
        else if (pattern[j] === ")") depth--;
        if (depth === 0) break;
        j++;
      }
      groups.push(pattern.slice(i + 1, j));
      i = j + 1;
      continue;
    }
    i++;
  }
  return groups;
}

// Map: Lua command name -> capture specs (null if the command doesn't use
// u.parse_args, e.g. it reads cmd.parameter directly - not applicable here).
async function extractLuaCommandPatterns(): Promise<Map<string, CaptureSpec[] | null>> {
  const result = new Map<string, CaptureSpec[] | null>();
  const files = await readdir(LUA_COMMANDS_DIR);

  for (const file of files) {
    if (!file.endsWith(".lua")) continue;
    const content = await readFile(join(LUA_COMMANDS_DIR, file), "utf-8");

    const addCmdRegex = /commands\.add_command\s*\(\s*"(fac_[^"]+)"/g;
    const matches = [...content.matchAll(addCmdRegex)];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i]!;
      const name = match[1]!;
      const start = match.index!;
      const end = i + 1 < matches.length ? matches[i + 1]!.index! : content.length;
      const chunk = content.slice(start, end);
      const parseMatch = chunk.match(/u\.parse_args\s*\(\s*"((?:[^"\\]|\\.)*)"/);
      if (!parseMatch) {
        result.set(name, null);
        continue;
      }
      const groups = extractCaptureGroups(parseMatch[1]!).map(classifyCaptureGroup);
      result.set(name, groups);
    }
  }

  return result;
}

interface TsPlaceholder {
  name: string;
  type: "number" | "string" | "boolean" | "unknown";
}

function extractTsPlaceholders(toolName: string): TsPlaceholder[] {
  const tool = TOOLS[toolName]!;
  const matches = [...tool.rcon.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)];
  return matches.map((m) => {
    const pName = m[1]!;
    const type = tool.params[pName]?.type ?? "unknown";
    return { name: pName, type };
  });
}

interface ArityIssue {
  tool: string;
  luaCmd: string;
  message: string;
}

function checkArity(toolName: string, luaCmd: string, captures: CaptureSpec[]): ArityIssue[] {
  const issues: ArityIssue[] = [];
  const placeholders = extractTsPlaceholders(toolName);

  const mandatoryCount = captures.filter((c) => !c.optional).length;
  const totalCount = captures.length;
  const tsCount = placeholders.length;

  if (tsCount < mandatoryCount || tsCount > totalCount) {
    issues.push({
      tool: toolName,
      luaCmd,
      message:
        `placeholder count ${tsCount} (${placeholders.map((p) => p.name).join(",") || "none"}) ` +
        `outside Lua capture range [${mandatoryCount}..${totalCount}] for pattern with ${totalCount} group(s)`,
    });
  }

  // Positional type check: a Lua capture group whose character class is
  // numeric-only (digits/./- only) can never successfully match a TS param
  // that carries a "string" value (entity/item/recipe names, etc.) - that
  // combination either fails to match at runtime or silently misaligns
  // subsequent captures. The reverse (numeric TS value into a generic
  // capture) is always safe, since digits are valid %S/.-class input too -
  // so it is intentionally not flagged.
  const n = Math.min(captures.length, placeholders.length);
  for (let i = 0; i < n; i++) {
    const cap = captures[i]!;
    const ph = placeholders[i]!;
    if (cap.numericOnly && ph.type === "string") {
      issues.push({
        tool: toolName,
        luaCmd,
        message:
          `position ${i + 1}: Lua capture "(${cap.raw})" is numeric-only but TS placeholder ` +
          `{${ph.name}} is type "string" - order/arity mismatch`,
      });
    }
  }

  return issues;
}

function mcpToLua(mcpName: string): string {
  // MCP tool "chat_say" -> Lua command "fac_chat_say"
  return `fac_${mcpName}`;
}

function luaToMcp(luaName: string): string {
  // Lua command "fac_chat_say" -> MCP tool "chat_say"
  return luaName.replace(/^fac_/, "");
}

async function main() {
  console.log("🔍 Validating MCP tools vs Lua commands...\n");

  const luaCommands = await extractLuaCommands();
  const luaPatterns = await extractLuaCommandPatterns();
  const mcpTools = new Set(Object.keys(TOOLS));
  const skills = new Set(Object.keys(SKILLS));

  // Special tools handled in TS (not 1:1 with Lua)
  const specialTools = new Set(["companion_status", "companion_stop"]);

  let errors = 0;

  // Check: Each MCP tool has a Lua command
  console.log("📋 MCP Tools -> Lua Commands:");
  for (const mcpTool of mcpTools) {
    const luaCmd = mcpToLua(mcpTool);
    const exists = luaCommands.has(luaCmd);
    const icon = exists ? "✅" : "❌";
    if (!exists) {
      console.log(`  ${icon} ${mcpTool} -> ${luaCmd} (MISSING IN LUA)`);
      errors++;
    }
  }

  // Check: Each Lua command has an MCP tool
  console.log("\n📋 Lua Commands -> MCP Tools:");
  for (const luaCmd of luaCommands) {
    const mcpTool = luaToMcp(luaCmd);
    const inTools = mcpTools.has(mcpTool);
    const inSkills = skills.has(mcpTool);
    const isSpecial = specialTools.has(mcpTool);

    if (!inTools && !inSkills && !isSpecial) {
      console.log(`  ❌ ${luaCmd} -> ${mcpTool} (NOT EXPOSED IN MCP)`);
      errors++;
    }
  }

  // Check: Arity/order between TS rcon templates and Lua parse_args patterns
  console.log("\n📋 Arity/order (TS placeholders vs Lua capture groups):");
  let arityChecked = 0;
  const arityIssues: ArityIssue[] = [];
  for (const mcpTool of mcpTools) {
    const luaCmd = mcpToLua(mcpTool);
    const captures = luaPatterns.get(luaCmd);
    if (!captures) continue; // Lua command doesn't use u.parse_args - nothing to cross-check
    arityChecked++;
    const issues = checkArity(mcpTool, luaCmd, captures);
    if (issues.length > 0) {
      arityIssues.push(...issues);
      for (const issue of issues) {
        console.log(`  ❌ ${mcpTool} (${luaCmd}): ${issue.message}`);
      }
    }
  }
  errors += arityIssues.length;
  if (arityIssues.length === 0) {
    console.log(`  ✅ All ${arityChecked} pattern-backed tools have consistent arity/order`);
  }

  // Summary
  console.log("\n📊 Summary:");
  console.log(`  Lua commands: ${luaCommands.size}`);
  console.log(`  MCP tools: ${mcpTools.size}`);
  console.log(`  Skills: ${skills.size}`);
  console.log(`  Special tools: ${specialTools.size}`);
  console.log(`  Arity-checked tools: ${arityChecked}`);

  if (errors === 0) {
    console.log("\n✅ All tools are 1:1 mapped!");
  } else {
    console.log(`\n❌ Found ${errors} mismatches!`);
    process.exit(1);
  }
}

main().catch(console.error);
