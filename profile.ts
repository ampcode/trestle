import { defineProfile, t } from "trestle";

/**
 * Vocabulary only — inert data. Behavior lives in extract/pipeline.ts
 * and resolvers/. Run `trestle profile build` after editing.
 */
export default defineProfile({
  nodes: {
    File: { identity: ["path"], props: { extension: t.string().optional() } },
  },
  edges: {},
  facts: {
    "file-inventoried": {
      version: 1,
      props: { path: t.string(), extension: t.string().optional(), bytes: t.number() },
    },
  },
});
