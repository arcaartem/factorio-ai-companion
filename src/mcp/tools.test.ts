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
  expect(TOOLS.resource_list!.rcon).toBe("/fac_resource_list {companionId} {filter} {radius}");

  const cmd = buildRCONCommand("resource_list", {
    companionId: 2,
    filter: "{radius}",
    radius: 99,
  });

  // filter's value is the literal string "{radius}" - it must land in the
  // filter slot untouched, and the real radius (99) must still land in the
  // radius slot rather than being consumed by the injected placeholder text.
  expect(cmd).toBe("/fac_resource_list 2 {radius} 99");
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

test("unknown tool name returns an empty string", () => {
  expect(buildRCONCommand("not_a_real_tool", {})).toBe("");
});
