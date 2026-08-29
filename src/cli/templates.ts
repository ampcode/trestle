/**
 * Scaffold templates written by `trestle init`. Ownership rule: init never
 * overwrites an existing file; re-running fills gaps only. Rendered files
 * are content-hashed into trestle/.scaffold.json so `trestle upgrade` can
 * tell never-modified files from user-edited ones.
 */

export const TEMPLATES: Record<string, string> = {
  "trestle.config.ts": `import type { TrestleConfig } from "trestle";

export default {
  // The corpus defaults to the enclosing repo (embedded mode).
  corpusRoots: [".."],
} satisfies TrestleConfig;
`,

  "profile.ts": `import { defineProfile, t } from "trestle";

/**
 * Vocabulary only — inert data. Behavior lives in extract/pipeline.ts
 * and resolvers/. Run \`trestle profile build\` after editing.
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
`,

  "extract/pipeline.ts": `import { pipeline } from "trestle";

/**
 * Seed pipeline: a file-inventory fact emitter. Edit this into your real
 * extraction — add tools via ctx.run, remote inputs via ctx.acquire, and
 * wrap per-unit work in ctx.memo for incremental re-extraction.
 */
export default pipeline(async ({ corpus, memo, emit }) => {
  for (const path of corpus.list()) {
    await memo(\`inventory:\${path}\`, [path], () => {
      const text = corpus.read(path);
      const dot = path.lastIndexOf(".");
      emit({
        kind: "file-inventoried",
        sourcePath: path,
        props: {
          path,
          extension: dot > 0 ? path.slice(dot + 1) : undefined,
          bytes: Buffer.byteLength(text),
        },
      });
    });
  }
});
`,

  "resolvers/inventory.ts": `import { resolver, mapFacts } from "trestle";

/**
 * Seed resolver: P0 fact mapping. The survey (\`trestle survey\`) tells you
 * which resolver to write next, ranked by unresolved population.
 */
export default resolver({
  name: "inventory",
  phase: 10,
  consumes: { facts: ["file-inventoried"] },
  run(slice, emit) {
    mapFacts(slice, emit, {
      "file-inventoried": [
        {
          node: (f) => ({
            kind: "File",
            identity: { path: f.props.path as string },
            props: { extension: f.props.extension as string | undefined },
          }),
          rule: "file-node",
        },
      ],
    });
  },
});
`,

  "AGENTS.md": `# Trestle project

This directory is the Trestle harness for this repository: profile
(vocabulary), extraction pipeline, resolvers, and migration units.

## The loop

1. \`trestle profile build\` — compile profile.ts to profile.lock.json
2. \`trestle extract\` — run the extraction pipeline (facts, incremental)
3. \`trestle resolve\` — run resolvers in phase order (graph)
4. \`trestle survey\` — what is unresolved, ranked; decides the next step

## Rules

- Vocabulary (node/edge/fact kinds) lives in profile.ts — inert data only.
- The pipeline transcribes; it never infers. Resolvers infer; they never
  read artifacts. Every edge carries evidence; every unmatched reference
  becomes a claim or an explicit ignore.
- Facts persist: iterate on resolvers without re-extracting.

## Project notes

(add project-specific conventions here)
`,

  ".gitignore": `.state/
node_modules/
`,
};
