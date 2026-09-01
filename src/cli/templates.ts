/**
 * Scaffold templates written by `trestle init`. Ownership rule: init never
 * overwrites an existing file; re-running fills gaps only. Rendered files
 * are content-hashed into trestle/.scaffold.json so `trestle upgrade` can
 * tell never-modified files from user-edited ones.
 */

/**
 * The harness manifest. Rendered with the installed trestle version so a
 * fresh clone can \`npm install\` inside trestle/ and get the same engine.
 * Trestle is distributed through its Amp-hosted git remote: npm resolves
 * \`#semver:\` ranges against pushed v* tags using the installer's Amp git
 * credentials, so no npm registry is needed.
 */
export const TRESTLE_GIT_URL = "git+https://ampcode.com/@jesse/trestle";

export function harnessPackageJson(version: string): string {
  return `${JSON.stringify(
    {
      name: "trestle-harness",
      private: true,
      type: "module",
      engines: { node: ">=23.6" },
      dependencies: { trestle: `${TRESTLE_GIT_URL}#semver:^${version}` },
    },
    null,
    2,
  )}\n`;
}

/**
 * Host-level environment bootstrap, scaffolded to <host>/.agents/setup.
 * Runs once in a fresh orb; its result is captured in the project snapshot,
 * so it must be idempotent and fast on a warm filesystem (a stale snapshot
 * re-runs it with node_modules already present).
 */
export function setupScript(harnessDir: string): string {
  return `#!/usr/bin/env bash
# Environment bootstrap for the Trestle harness (scaffolded by \`trestle init\`).
# Idempotent: safe to re-run on a warm filesystem or stale snapshot.
set -euo pipefail

cd "$(dirname "$0")/.."

# Trestle runs TypeScript natively and needs Node >= 23.6.
if ! command -v node >/dev/null 2>&1; then
  echo ".agents/setup: node not found; install Node >= 23.6" >&2
  exit 1
fi
if ! node -e 'const [M,m]=process.versions.node.split(".").map(Number);process.exit(M>23||(M===23&&m>=6)?0:1)'; then
  echo ".agents/setup: node $(node -v) is too old for trestle (need >= 23.6)" >&2
  exit 1
fi

echo ".agents/setup: installing trestle harness dependencies"
(cd ${harnessDir} && npm install)
`;
}

export const TEMPLATES: Record<string, string> = {
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  },
  "include": ["."]
}
`,

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
(vocabulary), extraction pipeline, and resolvers.

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

## Skills

Before editing each surface, load its skill (installed by \`trestle init\`
into \`.agents/skills/\`; each ends with project addenda you can extend):

- profile.ts → authoring-trestle-profiles
- extract/pipeline.ts → writing-trestle-extractors
- resolvers/*.ts → writing-trestle-resolvers
- deciding what to do next → running-the-trestle-loop

## Project notes

(add project-specific conventions here)
`,

  ".gitignore": `.state/
node_modules/
`,
};
