import { defineProfile, t } from "../../src/index.ts";

export default defineProfile({
  nodes: {
    File: { identity: ["path"] },
    Function: {
      identity: ["key"],
      props: { name: t.string(), path: t.string(), category: t.string(), exported: t.boolean(), tokens: t.number() },
    },
  },
  edges: {
    REFERENCES: { from: ["File"], to: ["Function"] },
    SAME_BODY: { from: ["Function"], to: ["Function"] },
    SIMILAR_BODY: { from: ["Function"], to: ["Function"] },
  },
  facts: {
    "file-parsed": { version: 1, props: { path: t.string() } },
    "function-declared": {
      version: 2,
      props: {
        key: t.string(), name: t.string(), path: t.string(), category: t.string(), exported: t.boolean(),
        bodyHash: t.string(), normalizedBodyHash: t.string(), tokens: t.number(),
      },
    },
    "reference-observed": { version: 1, props: { target: t.string() } },
  },
});
