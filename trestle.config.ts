import type { TrestleConfig } from "trestle";

export default {
  // Corpus roots: read-only source material, one pinned submodule per
  // estate under corpora/ (`trestle corpus add <git-url>`).
  corpusRoots: ["corpora"],
} satisfies TrestleConfig;
