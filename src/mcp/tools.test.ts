import { test, expect } from "bun:test";
import { buildRCONCommand, TOOLS } from "./tools";

// These tests pin down buildRCONCommand's substitution contract: a single
// regex pass over the *original* template, with values inserted verbatim
// (no $-pattern expansion, no re-scanning of already-substituted text).

test("chat_say inserts the message verbatim, immune to $-pattern expansion", () => {
  expect(TOOLS.chat_say!.rcon).toBe("/fac_chat_say {companionId} {message}");

  const cmd = buildRCONCommand("chat_say", {
    companionId: 1,
    message: "cost: $& $$ lol",
  });

  expect(cmd).toBe("/fac_chat_say 1 cost: $& $$ lol");
});

test("a value containing a literal {otherParam} does not shift later substitutions", () => {
  // radius before filter (T-015 (2)): the Lua parse_args pattern binds its
  // digit-only capture first, so the TS template's placeholder order must
  // match or the two arguments land in swapped captures.
  expect(TOOLS.resource_list!.rcon).toBe("/fac_resource_list {companionId} {radius} {filter}");

  const cmd = buildRCONCommand("resource_list", {
    companionId: 2,
    filter: "{radius}",
    radius: 99,
  });

  // filter's value is the literal string "{radius}" - it must land in the
  // filter slot untouched, and the real radius (99) must still land in the
  // radius slot rather than being consumed by the injected placeholder text.
  expect(cmd).toBe("/fac_resource_list 2 99 {radius}");
});

test("missing required argument throws", () => {
  expect(TOOLS.chat_say!.params.companionId?.required).toBe(true);

  expect(() => buildRCONCommand("chat_say", { message: "hi" })).toThrow(
    /Missing required argument\(s\)/
  );
});

test("optional args fill their default, or become empty with whitespace collapsed", () => {
  // resource_list: filter defaults to "", radius defaults to 50.
  expect(TOOLS.resource_list!.params.filter?.default).toBe("");
  expect(TOOLS.resource_list!.params.radius?.default).toBe(50);

  // With no args at all, this renders the same string as before the T-015 (2)
  // reorder ("/fac_resource_list 3 50") - filter is now the LAST placeholder,
  // so its empty default just trims off the end rather than leaving a gap in
  // the middle. What changed is the MEANING: against the old Lua pattern
  // (filter capture first) this string bound filter="50" and always reported
  // count 0; against the new pattern (radius capture first) it correctly
  // binds radius=50, filter="".
  const withDefaults = buildRCONCommand("resource_list", { companionId: 3 });
  expect(withDefaults).toBe("/fac_resource_list 3 50");

  // building_fuel: x and y are optional with NO default at all.
  expect(TOOLS.building_fuel!.params.x?.default).toBeUndefined();
  expect(TOOLS.building_fuel!.params.x?.required).toBeFalsy();
  expect(TOOLS.building_fuel!.params.y?.default).toBeUndefined();

  const withoutDefault = buildRCONCommand("building_fuel", {
    companionId: 4,
    fuelName: "coal",
    count: 5,
  });
  // x and y substitute to "", leaving runs of whitespace that must collapse
  // to single spaces and trim off the trailing one.
  expect(withoutDefault).toBe("/fac_building_fuel 4 coal 5");
});

test("resource_list's previously-broken call forms render correctly under the new order", () => {
  // Before the reorder, an explicit radius with no filter rendered
  // "/fac_resource_list 3 120" against a filter-first Lua pattern, which
  // greedily bound filter="120" (matching nothing) and silently reverted
  // radius to the Lua-side default of 50.
  const radiusOnly = buildRCONCommand("resource_list", { companionId: 3, radius: 120 });
  expect(radiusOnly).toBe("/fac_resource_list 3 120");

  // The case that actually changes shape: with BOTH an explicit filter and
  // radius, the old template put filter before radius ("5 iron-ore 80"),
  // which the new radius-first Lua pattern would misparse entirely (radius
  // capture is digit-only and can't match "iron-ore" at all). The new
  // template must place radius before filter.
  const both = buildRCONCommand("resource_list", {
    companionId: 5,
    radius: 80,
    filter: "iron-ore",
  });
  expect(both).toBe("/fac_resource_list 5 80 iron-ore");
});

test("building_fill's x/y are optional, matching its fuel/empty siblings", () => {
  // building_place and building_can_place use ([%d.-]+) (mandatory) in Lua and must
  // stay required - only building_fill relaxes to match building_fuel/building_empty's
  // ([%d.-]*) (optional).
  expect(TOOLS.building_fill!.params.x?.required).toBeFalsy();
  expect(TOOLS.building_fill!.params.y?.required).toBeFalsy();
  expect(TOOLS.building_place!.params.x?.required).toBe(true);
  expect(TOOLS.building_can_place!.params.x?.required).toBe(true);

  const withoutPosition = buildRCONCommand("building_fill", {
    companionId: 6,
    itemName: "coal",
    count: 10,
  });
  expect(withoutPosition).toBe("/fac_building_fill 6 coal 10");
});

test("unknown tool name returns an empty string", () => {
  expect(buildRCONCommand("not_a_real_tool", {})).toBe("");
});
