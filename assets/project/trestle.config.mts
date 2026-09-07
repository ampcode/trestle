import type { TrestleConfig } from "trestle";

export default {
  // Analyze this repository, excluding ignored files and Trestle's own files.
  corpusRoots: ["."],
  respectGitignore: true,
  corpusExclude: ["trestle", ".amp", ".agents", "trestle.config.mts"],
  state: "trestle/.state",
  profile: "trestle/profile.ts",
  profileLock: "trestle/profile.lock.json",
  pipeline: "trestle/extract/pipeline.ts",
  resolvers: "trestle/resolvers",

  // Browser graph presentation (served at / by `trestle serve`). Data
  // always comes from the live SQLite store; unspecified kinds receive
  // labels derived from their identity. Load trestle-visualizing to choose
  // semantic kind filters, readable pool sizes, and explicit stable colors.
  // This file inventory is a starter, not a semantic architecture view.
  visualization: {
    title: "Knowledge graph",
    nodes: {
      File: { label: "path", color: "#8b7cf6" },
    },
    edges: {},
  },
} satisfies TrestleConfig;
