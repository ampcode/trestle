import { test } from "node:test";
import assert from "node:assert/strict";
import { defineProfile, buildLock, isProfile, isProfileLock } from "../src/profile/define.ts";
import { canonicalJson, stableHash } from "../src/profile/canonical.ts";
import { t } from "../src/profile/schema.ts";
import { validateProps } from "../src/profile/validate.ts";
import { isJsonValue, isProperties, type Properties } from "../src/profile/value.ts";

test("defineProfile compiles builders to inert data", () => {
  const profile = defineProfile({
    nodes: { Program: { identity: ["name"], props: { language: t.enum("cobol", "java").optional() } } },
    edges: { CALLS: { from: ["Program"], to: ["Program"] } },
    facts: { "call-observed": { version: 1, props: { callee: t.string() } } },
  });
  assert.equal(profile.nodes.Program!.identity[0], "name");
  assert.deepEqual(profile.nodes.Program!.props.language, { t: "enum", values: ["cobol", "java"], optional: true });
  // no functions anywhere in the tree
  assert.doesNotThrow(() => JSON.stringify(profile));
});

test("defineProfile rejects functions in the tree", () => {
  assert.throws(
    () =>
      defineProfile({
        // SAFETY: intentionally bypass the schema type to test runtime rejection of functions.
        nodes: { X: { identity: ["id"], props: { bad: ((x: number) => x) as never } } },
        edges: {},
        facts: {},
      }),
    /is a function/,
  );
});

test("defineProfile rejects edges to undeclared node kinds", () => {
  assert.throws(
    () =>
      defineProfile({
        nodes: { A: { identity: ["id"] } },
        edges: { E: { from: ["A"], to: ["Ghost"] } },
        facts: {},
      }),
    /not a declared node kind/,
  );
});

test("edge identity props must be required scalars declared in props", () => {
  assert.throws(
    () =>
      defineProfile({
        nodes: { A: { identity: ["id"] } },
        edges: { E: { from: ["A"], to: ["A"], identity: ["ctx"] } },
        facts: {},
      }),
    /identity prop "ctx" is not declared/,
  );
});

test("lock hash is independent of declaration order", () => {
  const a = defineProfile({
    nodes: { A: { identity: ["id"] }, B: { identity: ["id"] } },
    edges: {},
    facts: { f1: { version: 1 }, f2: { version: 1 } },
  });
  const b = defineProfile({
    nodes: { B: { identity: ["id"] }, A: { identity: ["id"] } },
    edges: {},
    facts: { f2: { version: 1 }, f1: { version: 1 } },
  });
  assert.equal(buildLock(a).hash, buildLock(b).hash);
});

test("validateProps: required, typed, no undeclared", () => {
  const schemas = {
    name: { t: "string" },
    count: { t: "number", optional: true },
    mode: { t: "enum", values: ["a", "b"] },
  } satisfies Record<string, import("../src/profile/schema.ts").PropSchema>;
  assert.deepEqual(validateProps(schemas, { name: "x", mode: "a" }, "w"), []);
  assert.equal(validateProps(schemas, { mode: "a" }, "w").length, 1); // missing name
  assert.equal(validateProps(schemas, { name: "x", mode: "z" }, "w").length, 1); // bad enum
  assert.equal(validateProps(schemas, { name: "x", mode: "a", extra: 1 }, "w").length, 1); // undeclared
  assert.equal(validateProps(schemas, { name: 5, mode: "a" }, "w").length, 1); // wrong type
});

test("JSON contracts preserve canonical values and reject non-JSON trees", () => {
  const shared = { b: 2, a: 1, omitted: undefined };
  const value = { z: shared, a: [shared, undefined, NaN, Infinity] };
  assert.ok(isJsonValue(value));
  assert.ok(isProperties(value));
  assert.equal(canonicalJson(value), '{"a":[{"a":1,"b":2},null,null,null],"z":{"a":1,"b":2}}');
  assert.equal(stableHash(value), stableHash({ a: value.a, z: shared }));

  const cycle: Properties = {};
  cycle.self = cycle;
  assert.equal(isJsonValue(cycle), false);
  assert.equal(isJsonValue({ nested: [() => 1] }), false);
  assert.equal(isJsonValue(1n), false);
  assert.equal(isProperties([]), false);
  assert.equal(isProperties(null), false);
  assert.equal(validateProps({ n: { t: "number" } }, { n: Infinity }, "fact").length, 1);
});

test("profile boundary guards validate nested schemas rather than just the brand", () => {
  const profile = defineProfile({
    nodes: { A: { identity: ["id"], props: { tags: t.array(t.enum("x", "y")).optional() } } },
    edges: { E: { from: ["A"], to: ["A"] } },
    facts: { seen: { version: 1, props: { data: t.json() } } },
  });
  const lock = buildLock(profile);
  assert.ok(isProfile(profile));
  assert.ok(isProfileLock(JSON.parse(JSON.stringify(lock))));
  assert.equal(isProfile({ __trestleProfile: true }), false);
  assert.equal(isProfileLock({ ...lock, trestleLockVersion: 2 }), false);
  assert.equal(isProfileLock({ ...lock, profile: { ...lock.profile, nodes: { A: { identity: [42], props: {} } } } }), false);
  for (const schema of [
    { t: "array", items: { t: "enum", values: [42] } },
    { t: "string", optional: "yes" },
    { t: "missing" },
  ]) {
    assert.equal(isProfileLock({
      ...lock,
      profile: { ...lock.profile, facts: { seen: { version: 1, props: { data: schema } } } },
    }), false);
  }
});
