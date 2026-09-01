import type { TrestleConfig } from "trestle";

export default {
  // Corpus roots: read-only source material, one pinned submodule per
  // estate under corpora/ (`trestle corpus add <git-url>`).
  corpusRoots: ["corpora"],

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
