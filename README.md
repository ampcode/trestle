# Trestle

**A knowledge-graph harness for code migration.** Trestle turns a legacy
estate into a typed, evidence-backed graph that coding agents and humans
can query while planning and executing a migration.

> **Unstable alpha:** Trestle is under active development. Expect breaking
> changes to its APIs, CLI, graph format, and project structure.

The context in this codebase helps you and your agent define the vocabulary for your knowledge graph schema (`profile.ts`). It then helps you select the proper AST producer or language-specific parser (`extract/pipeline.ts`) to extract the raw facts. Finally, in `resolvers/*.ts` you define the mappings between raw facts and your vocabulary to construct the graph.

![Trestle graph explorer showing the Apache OFBiz order component and its dependencies](./docs/assets/ofbiz-knowledge-graph.png)

<sub>A 40-node view centered on `order` from an Apache OFBiz dogfood graph
with 10,646 nodes and 34,916 evidence-backed edges.</sub>

- **Evidence on every edge.** Each edge cites the facts (file + location)
  that justify it and the rule that produced it.
- **Designed for Agents.** The repo ships `AGENTS.md` and skills that make setup super easy. Just ask the agent what to do next and it will walk you through the steps to bootstrap a graph.

## Requirements

- Node.js **≥ 23.6** (native TypeScript execution and `node:sqlite`)
- Git

`npm install` at the root pulls the one runtime dependency,
[`@ladybugdb/core`](https://www.npmjs.com/package/@ladybugdb/core), for the
Cypher projection.

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
          { evidence: [fc, dd], rule: "assign-to-dd" });
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
graph.

## Querying and serving

`trestle serve` exposes the live graph three ways from one process:

- **`/`** — an interactive [G6VP](https://github.com/antvis/G6VP) explorer
  reading the SQLite store directly (reflects the latest `resolve` on
  refresh).
- **`/mcp`** — an MCP server (`graph_query` and friends) that any MCP client
  can attach to.
- **`/api/query`** — Cypher over the LadybugDB projection (`project build`).

The explorer is already bundled. Its HTML response includes preload hints
for `/api/graph` and the pinned G6VP icon resources, so high-latency clients
can fetch them alongside the app instead of waiting for JavaScript execution.
These are serving-time headers; production build files are unchanged. The
icon hints must stay aligned with the SDK's icon set when upgrading it.

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

## Development checks

```sh
npm run lint       # Oxlint + all 15 generic dmmulroy/anti-slop rules
npm run typecheck  # engine and JSX app
npm test           # rebuild the UI, then run the test suite
```

Anti-slop's source and installer are versioned in
`.agents/skills/installing-anti-slop/`. `npm run lint` first regenerates
the gitignored rule modules under `tools/oxlint/anti-slop/`, without a
network fetch. Lint includes application code and tests, but excludes
corpora, generated bundles, and vendored tools.
All rules remain errors; runtime `typeof` checks are allowed only inside
explicit type guards. JSON payloads use the shared `JsonValue`/`Properties`
contracts, while SQLite reads use schema-specific row types. See the
[vendoring and orb setup notes](./tools/oxlint/anti-slop/README.md).

## Migration coordination

Migration units live in the same SQLite database as the graph, in separate
tables untouched by extraction and resolver retirement. Every unit has exactly
one designated lead session, including when paused or complete. A provider/session
pair can lead only one unit. The native harness creates and runs sessions;
Trestle records their identifiers without checking availability or controlling execution.

```sh
npx trestle migration create '{"id":"orders","title":"Extract orders","objective":"Separate order processing","acceptance":"Contract tests pass","scope":["Module:orders"],"sourceRevision":"<source-commit>","provider":"amp","session":"<existing-session-id>"}'
npx trestle migration list
npx trestle migration get '{"id":"orders"}'
npx trestle migration status '{"id":"orders","revision":1,"status":"active"}'
npx trestle migration bookmark '{"id":"orders","kind":"verification","provider":"amp","session":"<existing-session-id>","locator":"<artifact-or-message-reference>","description":"Contract test output"}'
npx trestle migration handoff '{"id":"orders","revision":2,"provider":"codex","session":"<replacement-session-id>","locator":"<handoff-evidence-reference>","description":"Continue from the recorded decision"}'
```

The `migration` MCP tool accepts the same JSON fields plus `operation`.
Creation freezes explicit scope IDs and a source revision reference; these are
caller-supplied references, not validated source snapshots. Scope and contract
are immutable in this initial registry. Status is `planned`, `active`, `blocked`,
or `complete`; completion is reported, not independently verified.
Status changes and lead handoffs require the current unit revision. Handoffs
atomically replace the lead and retain the previous binding and an evidence bookmark.
Bookmarks retain provider/session attribution and locators. They can also pin an
immutable indexed artifact version. Legacy locator-only bookmarks remain readable.

The MCP endpoint can now write coordination records. Keep it behind the trusted
portal boundary; a session identifier is attribution, not authentication or permission.
There is no scheduler, worker queue, or session spawning.

### Provider-neutral artifact index and bookmarks

Any connector can submit the same artifact envelope through CLI or the `migration`
MCP tool. No Amp identifiers are required:

```sh
npx trestle migration artifact-import '{"provider":"codex","session":"native-session","artifacts":[{"externalId":"message-1","kind":"message","locator":"native:message-1","metadata":{"role":"assistant"},"content":"Approved decision excerpt"}]}'
npx trestle migration artifact-search '{"provider":"codex","query":"decision"}'
npx trestle migration artifact-get '{"artifactId":"<returned-artifact-id>"}'
npx trestle migration bookmark '{"id":"orders","artifactId":"<returned-artifact-id>","kind":"decision","description":"Boundary decision"}'
npx trestle migration bookmark-get '{"bookmarkId":1}'
```

- Imports accept 1–20 records atomically. Re-importing an identical record returns
  the same ID; changed content, metadata, kind or locator creates another version.
  `contentHash` fingerprints that captured payload, not independently verified source.
- Provider + session + external ID names the native artifact. Artifact IDs also
  include the payload hash. Bookmarks pin these immutable versions, not “latest.”
- Omit `content` for metadata-only storage. Search filters by provider, session and
  kind, with literal case-insensitive substring matching on metadata/captured text.
  Results omit content and paginate with `offset`/`nextOffset` (20 per page).
  All retained versions are searchable; `artifact-get` retrieves a specific version.
- `bookmark-get` returns the bookmark and captured artifact, or `artifact: null`
  for a legacy locator-only bookmark. Unit `get` lists its bookmarks and artifact IDs.
- Capture is explicit. Connectors must redact sensitive data before import;
  Trestle does not automatically redact, authenticate provenance, or verify assertions.
  Retained text shares the database's access boundary and backup/retention policy.
  Metadata-only records still require native storage to retrieve original content.

### Amp adapter

The project plugin exposes `trestle_amp`, using the portal authenticated by
`trestle_auth`. It obtains the current thread ID from Amp's invocation context,
not model-supplied arguments:

- `create`: pass `id` and unit fields in `arguments`; this thread becomes lead.
- `index`: page through message IDs, roles and tool names using `offset` (20 per
  page), including compacted history. Default is read-only. Set `persist: true`
  to retain that page's metadata; the response includes artifact IDs.
- `bookmark`: pass `id`, an exact `message_id` from the index, and
  `arguments: {kind, description}`. The adapter verifies that the message exists
  and imports its metadata before bookmarking the returned artifact version.
  Its native locator contains the thread URL and exact message ID.
- `handoff`: run from the replacement lead thread with `id`, `message_id`, and
  `arguments: {revision, description}` pointing to its handoff evidence.
- `get`, `list`, `status`: access the shared registry (`id` at the top level;
  `revision` and `status` in `arguments`).

For indexing (with `persist`), bookmarking or handoff, `capture_text: true` opts
into retaining visible text. Review it for sensitive content first. Thinking blocks
and tool inputs/outputs are never captured by this adapter. A bookmark without
capture pins metadata, not a transcript copy. Import precedes bookmarking, so a
failed bookmark can leave an indexed artifact; retrying the import is idempotent.
No automatic trace export runs in the background. Amp retains the original messages
and controls session execution. Use `trestle_call` with `tool: "migration"` for
provider-neutral artifact search/retrieval and bookmark retrieval.

## Upgrading

Git is the distribution channel.

```sh
git remote add upstream https://github.com/ampcode/Trestle.git   # once
git fetch upstream && git merge upstream/main
```

Engine code lives in `src/`; your profile, pipeline, resolvers, and corpora
live beside it and rarely conflict.

## License

[Apache-2.0](./LICENSE)
