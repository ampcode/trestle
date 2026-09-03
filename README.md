# Trestle

**A knowledge-graph harness for code migration.** Trestle turns a legacy
estate into a typed, evidence-backed graph that coding agents and humans
can query while planning and executing a migration.

You declare the vocabulary (`profile.ts`), transcribe what the source code
literally says (`extract/pipeline.ts`), and infer the graph from those facts
(`resolvers/*.ts`). Trestle keeps the facts, the graph, the evidence for
every edge, and an explicit list of what it could *not* resolve. It does not
rewrite code and it does not orchestrate work — it is the map, not the
crew.

```
corpora/*  ──extract──▶  facts  ──resolve──▶  nodes · edges · evidence · claims
                                                    │
                                          survey · doctor · project · serve
```

- **Evidence on every edge.** Each edge cites the facts (file + location)
  that justify it, the rule that produced it, and a confidence.
- **Claims, not guesses.** Unmatched references (dynamic dispatch,
  unresolved copybooks, ambiguous includes) become claims for a human or
  agent to settle.
- **Incremental and idempotent.** Facts persist; re-running `extract` skips
  unchanged inputs, re-running `resolve` reports `live graph unchanged`.
- **Agent-native.** The repo ships `AGENTS.md` and skills that teach a coding
  agent to survey a corpus, choose parsers, write resolvers, and read the
  survey — unaided.

Trestle has been run against COBOL/JCL/CICS (AWS CardDemo, IBM CBSA), a
Java monolith (Apache OFBiz), a .NET WebForms CMS (mojoPortal), and a
5.3M-line C++ estate (OpenOffice.org 1.0). See
[CASE-STUDIES.md](./CASE-STUDIES.md).

## Requirements

- Node.js **≥ 23.6** (native TypeScript execution and `node:sqlite`)
- Git
- Optional: [`@ladybugdb/core`](https://www.npmjs.com/package/@ladybugdb/core)
  for the Cypher projection (`project build`/`project query`)

## Quick start

This repository *is* the graph repo. Fork it, pin the code you are analyzing
as read-only submodules under `corpora/`, and edit the user surface at the
root. There is no installer and no `init`.

```sh
git clone <your-fork> my-graph && cd my-graph
./.agents/setup                                  # checks Node, inits submodules, npm install

npx trestle corpus add https://github.com/apache/ofbiz-framework
                                                 # shallow submodule under corpora/
npx trestle profile build                        # profile.ts -> profile.lock.json
npx trestle extract                              # pipeline -> facts
npx trestle resolve                              # resolvers -> graph
npx trestle survey                               # what is unresolved, ranked
npx trestle doctor                               # graph health checks

npx trestle project build                        # Cypher projection (LadybugDB)
npx trestle project query 'MATCH (p:Program)-[r:WRITES]->(d) RETURN p, r, d LIMIT 20'
npx trestle serve                                # graph explorer at /, MCP at /mcp
```

A complete worked example — profile, pipeline, two resolvers, sample
corpus — lives in [`examples/mainframe-mini`](./examples/mainframe-mini).

## How it works

Three files at the root define a graph. Each is ordinary TypeScript.

**`profile.ts`** — the vocabulary: node kinds with identities, edge kinds
with endpoints, and the fact kinds the pipeline may emit.

```ts
import { defineProfile, t } from "trestle";

export default defineProfile({
  nodes: {
    Program: { identity: ["name"] },
    Dataset: { identity: ["name"] },
  },
  edges: {
    WRITES: { from: ["Program"], to: ["Dataset"], props: { ddName: t.string().optional() } },
  },
  facts: {
    "binding-observed": { version: 1, props: { program: t.string(), ddName: t.string() } },
  },
});
```

**`extract/pipeline.ts`** — transcription. It reads the corpus and emits
facts with source locations. It never infers; joining is the resolvers'
job. Cells are memoized on their inputs, so re-extraction is incremental.

```ts
import { pipeline } from "trestle";

export default pipeline(async ({ corpus, memo, emit }) => {
  for (const path of corpus.list(".cbl")) {
    await memo(`cobol:${path}`, [path], () => {
      const text = corpus.read(path);
      for (const m of text.matchAll(/SELECT\s+(\w+)\s+ASSIGN\s+TO\s+(\w+)/g)) {
        emit({ kind: "binding-observed", sourcePath: path,
               locator: { type: "lines", startLine: lineAt(text, m.index) },
               props: { program: programOf(text), ddName: m[2]! } });
      }
    });
  }
});
```

**`resolvers/*.ts`** — inference. Resolvers run in phase order, join facts
into nodes and edges, cite evidence from both sides of every join, and
raise claims for what they cannot match.

```ts
import { resolver } from "trestle";

export default resolver({
  name: "dd-resolution",
  phase: 20,
  consumes: { facts: ["binding-observed", "dd-card-observed"] },
  run(slice, emit) {
    const dds = slice.index("dd-card-observed", (f) => [f.props.ddName as string]);
    for (const fc of slice.facts("binding-observed")) {
      const matches = dds.get([fc.props.ddName as string]);
      if (matches.length === 0) {
        emit.claim("unallocated-dd", {
          about: [`Program:${fc.props.program}`],
          detail: `ASSIGN TO ${fc.props.ddName} is never allocated by a DD card`,
          rule: "unmatched-assign",
        });
        continue;
      }
      for (const dd of matches) {
        emit.edge("WRITES",
          { from: `Program:${fc.props.program}`, to: `Dataset:${dd.props.dataset}` },
          { evidence: [fc, dd], confidence: 0.95, rule: "assign-to-dd" });
      }
    }
  },
});
```

Then loop: edit, `extract`, `resolve`, read `survey`, repeat. The survey
ranks unresolved populations so the next resolver to write is obvious.

Parsers are your choice. The pipeline can shell out to compilers, indexers
(SCIP, ctags), tree-sitter, or hand-written column-aware readers for
formats no modern tool handles; all of them are just fact emitters. The
`extraction` skill includes a tool-selection index by language.

## Working with coding agents

Trestle is designed to be driven by an agent. The repo ships:

- [`AGENTS.md`](./AGENTS.md) — the loop and the rules (transcribe vs.
  infer, evidence discipline, never edit `corpora/`).
- [`.agents/skills/`](./.agents/skills) — `profiles`, `extraction`,
  `resolvers`, `loop`: task-specific guidance the agent loads before
  touching each surface.
- [`.agents/setup`](./.agents/setup) — environment bootstrap, run
  automatically by Amp orbs.
- [`.amp/services.yaml`](./.amp/services.yaml) — declares `trestle serve` as
  a supervised service with a portal, so a graph is one command away.
- [`.amp/plugins/trestle.ts`](./.amp/plugins/trestle.ts) — `trestle_auth`,
  `trestle_query`, `trestle_call` tools for querying a served graph from
  other threads.

Point an agent at a fresh fork with a corpus added and ask it to build the
graph. That is how every case study was produced.

## Querying and serving

`trestle serve` exposes the live graph three ways from one process:

- **`/`** — an interactive [G6VP](https://github.com/antvis/G6VP) explorer
  reading the SQLite store directly (reflects the latest `resolve` on
  refresh).
- **`/mcp`** — an MCP server (`graph_query` and friends) that any MCP client
  can attach to.
- **`/api/query`** — Cypher over the optional LadybugDB projection.

Presentation lives in `trestle.config.ts`:

```ts
export default {
  corpusRoots: ["corpora"],
  visualization: {
    title: "Migration knowledge graph",
    nodes: { Program: { label: "name", color: "#9b87f5" } },
    edges: { CALLS: { color: "#42b7ff", width: 1.25 } },
  },
} satisfies TrestleConfig;
```

## Corpora

Estates live under `corpora/` and are never edited.

```sh
npx trestle corpus add <git-url> [name] [--ref <branch|tag|sha>]   # shallow submodule
npx trestle corpus add <archive-url> [name] [--sha256 <hash>]      # .tar.gz/.zip, manifest committed
npx trestle corpus restore                                          # refetch archive corpora
```

Git corpora are pinned by submodule SHA; archive corpora are pinned by a
committed `corpora/<name>.source.json` manifest. Neither commits corpus
bytes to your graph repo.

## Upgrading

Git is the distribution channel.

```sh
git remote add upstream https://ampcode.com/@jesse/trestle   # once
git fetch upstream && git merge upstream/main
```

Engine code lives in `src/`; your profile, pipeline, resolvers, and corpora
live beside it and rarely conflict.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — design, invariants, consumer contract
- [EXTRACT-RESOLVE.md](./EXTRACT-RESOLVE.md) — the pipeline and resolver SDK
- [RESOLVER-KIT.md](./RESOLVER-KIT.md) — resolver patterns (index, rules, join, emit)
- [CASE-STUDIES.md](./CASE-STUDIES.md) — what happened on real estates
- [REGRESSION-SCENARIOS.md](./REGRESSION-SCENARIOS.md) — behaviors the tests pin

## Development

```sh
npm install
npx tsc --noEmit
npm test              # node --test tests/*.test.ts
```

Graph work (profile, pipeline, resolvers) should never require engine
changes. If it does, send the change upstream.

## Prior art

Trestle generalizes [strangler-fig](https://github.com/JEdelstein25/strangler-fig)
(mainframe evidence graphs and boundary discovery) and pairs with
[ampx](https://github.com/JEdelstein25/ampxtra), a coordination ledger for
long-running agent migrations that consumes the graph read-only.

## License

[Apache-2.0](./LICENSE)
