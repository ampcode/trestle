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
  // stable colors and labels derived from their identity.
  visualization: {
    title: "Knowledge graph",
    nodes: {
      File: { label: "path", color: "#8b7cf6" },
    },
    edges: {},
  },
} satisfies TrestleConfig;
