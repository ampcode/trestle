import { test } from "node:test";
import assert from "node:assert/strict";
import { defineProfile, buildLock } from "../src/profile/define.ts";
import { t } from "../src/profile/schema.ts";
import { validateProps } from "../src/profile/validate.ts";

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
  const schemas: Record<string, import("../src/profile/schema.ts").PropSchema> = {
    name: { t: "string" },
    count: { t: "number", optional: true },
    mode: { t: "enum", values: ["a", "b"] },
  };
  assert.deepEqual(validateProps(schemas, { name: "x", mode: "a" }, "w"), []);
  assert.equal(validateProps(schemas, { mode: "a" }, "w").length, 1); // missing name
  assert.equal(validateProps(schemas, { name: "x", mode: "z" }, "w").length, 1); // bad enum
  assert.equal(validateProps(schemas, { name: "x", mode: "a", extra: 1 }, "w").length, 1); // undeclared
  assert.equal(validateProps(schemas, { name: 5, mode: "a" }, "w").length, 1); // wrong type
});
