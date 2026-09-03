/**
 * A tiny graph repo generated into a temp dir for engine tests: two
 * modules, one resource manifest, and resolvers that exercise every
 * directive the engine supports — declared nodes, a join edge with
 * two-sided evidence, an auto-vivified stub, and a claim.
 *
 *   Module A ─CALLS→ Module B          (declared → declared)
 *   Module A ─CALLS→ Module Z          (Z is a stub: never defined)
 *   Module A ─READS→ Resource ledger   (evidence: a.mod line + manifest line)
 *   Module B reads "orders"            (not in the manifest → claim)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "../src/cli/main.ts";

const TRESTLE = pathToFileURL(join(import.meta.dirname, "..", "src", "index.ts")).href;

export const FIXTURE = {
  nodes: 4, // A, B, ledger declared; Z stub
  edges: 3,
  claims: 1,
  modules: ["A", "B", "Z"],
  stubs: ["Z"],
} as const;

const files: Record<string, string> = {
  "trestle.config.ts": `import type { TrestleConfig } from "${TRESTLE}";
export default { corpusRoots: ["corpus"] } satisfies TrestleConfig;
`,
  "profile.ts": `import { defineProfile, t } from "${TRESTLE}";
export default defineProfile({
  nodes: {
    Module: { identity: ["name"] },
    Resource: { identity: ["name"] },
  },
  edges: {
    CALLS: { from: ["Module"], to: ["Module"] },
    READS: { from: ["Module"], to: ["Resource"], props: { context: t.string() }, identity: ["context"] },
  },
  facts: {
    "module-defined": { version: 1, props: { name: t.string() } },
    "call-observed": { version: 1, props: { caller: t.string(), callee: t.string() } },
    "read-observed": { version: 1, props: { module: t.string(), resource: t.string(), context: t.string() } },
    "resource-defined": { version: 1, props: { name: t.string() } },
  },
});
`,
  "extract/pipeline.ts": `import { pipeline } from "${TRESTLE}";
export default pipeline(async ({ corpus, memo, emit }) => {
  for (const path of corpus.list(".mod")) {
    await memo(\`mod:\${path}\`, [path], () => {
      const lines = corpus.read(path).split("\\n");
      const name = lines[0]!.replace("MODULE ", "");
      emit({ kind: "module-defined", sourcePath: path, locator: { type: "lines", startLine: 1 }, props: { name } });
      lines.forEach((line, i) => {
        const loc = { type: "lines", startLine: i + 1 };
        const call = /^CALL (\\w+)$/.exec(line);
        if (call) emit({ kind: "call-observed", sourcePath: path, locator: loc, props: { caller: name, callee: call[1]! } });
        const read = /^READ (\\w+) IN (\\w+)$/.exec(line);
        if (read) emit({ kind: "read-observed", sourcePath: path, locator: loc, props: { module: name, resource: read[1]!, context: read[2]! } });
      });
    });
  }
  for (const path of corpus.list("resources.txt")) {
    await memo(\`res:\${path}\`, [path], () => {
      corpus.read(path).split("\\n").forEach((line, i) => {
        const m = /^RESOURCE (\\w+)$/.exec(line);
        if (m) emit({ kind: "resource-defined", sourcePath: path, locator: { type: "lines", startLine: i + 1 }, props: { name: m[1]! } });
      });
    });
  }
});
`,
  "resolvers/entities.ts": `import { resolver, mapFacts } from "${TRESTLE}";
export default resolver({
  name: "entities", phase: 10,
  consumes: { facts: ["module-defined", "resource-defined", "call-observed"] },
  run(slice, emit) {
    mapFacts(slice, emit, {
      "module-defined": [{ node: (f) => ({ kind: "Module", identity: { name: f.props.name as string } }), rule: "module-node" }],
      "resource-defined": [{ node: (f) => ({ kind: "Resource", identity: { name: f.props.name as string } }), rule: "resource-node" }],
      "call-observed": [{ edge: "CALLS", from: (f) => \`Module:\${f.props.caller}\`, to: (f) => \`Module:\${f.props.callee}\`, rule: "literal-call" }],
    });
  },
});
`,
  "resolvers/reads.ts": `import { resolver } from "${TRESTLE}";
export default resolver({
  name: "reads", phase: 20,
  consumes: { facts: ["read-observed", "resource-defined"] },
  run(slice, emit) {
    const defined = slice.index("resource-defined", (f) => [f.props.name as string]);
    for (const r of slice.facts("read-observed")) {
      const matches = defined.get([r.props.resource as string]);
      if (matches.length === 0) {
        emit.claim("unknown-resource", { about: [\`Module:\${r.props.module}\`], detail: \`\${r.props.resource} is not in the manifest\`, rule: "read-join" });
        continue;
      }
      for (const d of matches) {
        emit.edge("READS",
          { from: \`Module:\${r.props.module}\`, to: \`Resource:\${d.props.name}\`, identity: { context: r.props.context as string } },
          { evidence: [r, d], rule: "read-join" });
      }
    }
  },
});
`,
  "corpus/a.mod": "MODULE A\nCALL B\nCALL Z\nREAD ledger IN nightly\n",
  "corpus/b.mod": "MODULE B\nREAD orders IN nightly\n",
  "corpus/resources.txt": "RESOURCE ledger\n",
};

/** Write the fixture repo and build its graph; returns the repo and state dirs. */
export async function buildFixture(prefix: string): Promise<{ repo: string; state: string }> {
  const repo = mkdtempSync(join(tmpdir(), `trestle-${prefix}-`));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }
  const state = join(repo, ".state");
  const overrides = { state };
  await runCli(["profile", "build"], repo, overrides);
  await runCli(["extract"], repo, overrides);
  await runCli(["resolve"], repo, overrides);
  return { repo, state };
}
