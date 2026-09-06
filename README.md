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

### Retrieving supporting evidence

After upgrading, run `npx trestle project build` once to add relationship
`stableId` columns to an existing projection.

Query `stableId` (not Ladybug's internal IDs), for example:

```cypher
MATCH (a)-[e]->(b) RETURN e.stableId AS edgeId LIMIT 10
```

Call the MCP tool `graph_evidence` with
`{"entityType":"edge","stableId":"<edgeId>","limit":50}`. For node IDs,
use `entityType: "node"`. In Amp, use the existing portal authentication and:

```json
{"tool":"graph_evidence","arguments":{"entityType":"edge","stableId":"<edgeId>","limit":50}}
```

Pass that object to `trestle_call`. The response contains `revision`, `generation`,
`entityType`, `stableId`, `kind`, `status`, `retiredRev`, `evidence`, `limit`,
`afterId`, `truncated`, and `nextAfterId`. Each evidence record includes its
row `id`, `sourcePath`, decoded `locator`, `resolver`, `resolverVersion`,
`rule`, `note`, `createdRev`, `retiredRev`, `factId`, and the exact referenced
`fact` (kind/version/cell, sourcePath/locator, authority, props, and revisions).
Evidence locations and fact locations are preserved separately, not combined
or inferred. Null means absent; a non-null `factId` with null `fact` is a
dangling reference. No source file contents are read or returned.

Only live evidence on live entities is returned. A live entity can have no
evidence (notably a stub); `status: "retired"` and `status: "not_found"`
also return empty evidence. The wrong entity type is `not_found`. Retired
evidence history is not exposed. A live evidence row can still reference a
retired fact; its original provenance and `fact.retiredRev` are returned,
not replaced with a newer fact.

Results are ordered by evidence row ID. `limit` defaults to 50 (1–200);
when `truncated` is true, pass `nextAfterId` as `afterId` for the next page.
Also pass the first page's `generation` as `expectedGeneration`: an intervening
committed mutation rejects the request. On mismatch, discard accumulated pages
and restart at `afterId: 0` without the old guard. For compatibility the guard
is optional; clients omitting it must compare `generation` on every page and
restart if it differs. Each request reads one SQLite snapshot. `revision` is
only a run/provenance ID and cannot detect mutations within one extraction run.
`generation` is a durable store-wide mutation token, not a commit count: it
changes transactionally with facts, graph entities, evidence, contributions,
aliases, claims, decisions and profile activation, and rolls back with failed
writes. Run allocation and unchanged memo-cell skips do not change it. A
resolver rerun replaces evidence rows, so it invalidates pagination even when
the logical graph is unchanged. Page size bounds records, not bytes. Retrieval reads the current
authoritative store without rebuilding the projection, so an older Cypher
result can identify an entity that has since retired. Stable IDs are looked
up exactly; aliases are not followed.

### Resolver contributions

Each resolver run replaces that resolver's node/edge declarations, properties,
and evidence atomically. Repeated declarations within a run union properties.
Across resolvers, disjoint properties enrich the entity and equal values may
be shared. Different values for the same property reject the whole batch with
the property and resolver names; there is no last-writer precedence. Omitting
a property on the next run retracts that resolver's value. Another resolver's
equal value or independent enrichment remains. The legacy `owner` field is a
representative contributor, not exclusive ownership.

Removing or renaming a resolver retires only its contributions. Shared entities
survive; a node whose declarations disappear but which remains an edge endpoint
becomes a property-free stub. Existing alias identity/re-pointing behavior is
unchanged. Node contributions retain their original declaration identity:
canonical declarations take property precedence over aliased declarations on
both merge and rerun. Alias-only properties still update and retract; shadowed
alias values become visible if the canonical property is retracted. Conflicts
between resolvers declaring the same original identity still fail, even when
the conflicting property is shadowed by a canonical declaration.

On older stores, migration preserves existing properties under the recorded
owner and preserves other live evidence contributors with empty property sets.
The old store did not record property attribution, so it cannot be recovered
exactly: rerun all resolvers to establish explicit contributions. Resolve any
newly reported conflicting values rather than relying on prior resolver order.

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

## Projection consistency and upgrades

Cypher queries use Ladybug's database-level read-only mode, including CLI,
MCP `graph_query`, and HTTP `/api/query`. Mutations cannot change the
projection, even in multi-statement input; queries must return one statement's
result. SQLite remains authoritative.

`project build` captures graph rows, evidence counts, and `Store.currentGeneration()`
in one synchronous SQLite read transaction before materialization. The generation
is an opaque committed-data equality token, not a run/revision number. A build
inside an existing Store transaction is rejected rather than publishing uncommitted
data. Detailed evidence remains in SQLite.

Builds create immutable `projection.lbug.generation-*/data.lbug` databases,
checkpoint and close the writer, verify a read-only reopen, then atomically replace
`projection.lbug.current.json`. Readers resolve this manifest once per query.
Builders exclude one another with `projection.lbug.build-lock`; a competing build
fails with a retry message. Failed rebuilds leave the last published generation
usable. No open database is renamed or deleted. Old and failed generation
directories are retained: remove unreferenced directories only after stopping all
readers/builders. A crashed builder's lock also requires removal after confirming
that the builder has stopped. Publication is atomic on the local filesystem;
this is not a power-loss durability guarantee.

Existing single-file projections still open read-only, with unknown source
generation (`null`). Rebuild to publish the new format and obtain a generation;
the legacy file remains untouched. Downgrading requires an offline rebuild with
the old engine, which does not understand manifests.

Existing row-array responses remain compatible. Source-generation reporting:

- `buildProjection` returns `sourceGeneration`; CLI build output includes it.
- `queryProjectionWithMetadata` returns `{rows, sourceGeneration}`;
  `queryProjection` still returns rows only.
- MCP `graph_query` accepts `includeMetadata: true` for that envelope. Compare its
  generation with `graph_evidence.generation` to detect staleness.
- Amp `trestle_query` accepts the same `includeMetadata: true` option.
- HTTP `/api/query` keeps its row-array body and adds
  `X-Trestle-Source-Generation` (`null` for legacy projections).
- CLI `project query` keeps JSON rows on stdout and prints generation on stderr.

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

The provider-neutral `trestle/coordination` module stores migration units,
session observations, unit history, immutable artifacts, and version-pinned
bookmarks in the graph's SQLite database. Coordination tables are independent
of extraction and resolution. Every unit always has one designated lead;
a session belongs to at most one unit, as lead or contributor.

```sh
npx trestle coordination registerSession '{"ref":{"provider":"codex","sessionId":"native-session"}}' register-orders-1
npx trestle coordination createUnit '{"id":"orders","title":"Extract orders","objective":"Separate order processing","acceptance":"Contract tests pass","scope":{"graphRevision":0,"entityIds":["Module:orders"],"sourceRevision":"<source-commit>"},"lead":{"provider":"codex","sessionId":"native-session"}}' create-orders-1
npx trestle coordination listUnits '{}'
npx trestle coordination setUnitStatus '{"id":"orders","expectedRevision":1,"status":"active","reason":"Implementation started"}' activate-orders-1
```

The `coordination` MCP tool accepts `{operation, arguments, requestId}`.
Mutations require durable idempotency keys; status changes and handoffs also
require the current unit revision. Session activity is timestamped observation,
not a migration status or a guarantee of availability. The native harness owns
execution: there is no scheduler, worker queue, or session spawning in Trestle.

See [the core API and connector guide](./docs/coordination.md) for all types,
operations, evidence capture, actor attribution, and automatic legacy upgrades.
The old `migration` CLI/MCP API has been removed, not retained as a parallel
session-management implementation.

### Amp adapter

The project plugin exposes `trestle_amp`, using the portal authenticated by
`trestle_auth`. It obtains the current thread ID from Amp's invocation context,
not model-supplied arguments. Mutations require a stable `request_id`:

- `create`: pass `id` and unit fields (including the scope object) in `arguments`;
  this thread becomes lead.
- `index`: page through message IDs, roles and tool names using `offset` (20 per
  page), including compacted history. Default is read-only. Set `persist: true`
  to retain that page's metadata; the response includes artifact IDs.
- `bookmark`: pass `id`, an exact `message_id` from the index, and
  `arguments: {kind, description}`. The adapter verifies that the message exists
  and imports its metadata before bookmarking the returned artifact version.
  Its native locator contains the thread URL and exact message ID.
- `handoff`: run from the replacement lead thread with `id`, `message_id`, and
  `arguments: {expectedRevision, description}` pointing to its handoff evidence.
- `get`, `list`, `status`: access the shared registry (`id` at the top level;
  `expectedRevision`, `status`, and `reason` in `arguments` for status).
- `register`, `attach`, `observe`: register this thread, attach it to `id`, or
  report `arguments: {state, observedAt, nativeState?}` for this thread.

For indexing (with `persist`), bookmarking or handoff, `capture_text: true` opts
into retaining visible text. Review it for sensitive content first. Thinking blocks
and tool inputs/outputs are never captured by this adapter. A bookmark without
capture pins metadata, not a transcript copy. Import precedes bookmarking, so a
failed bookmark can leave an indexed artifact; retrying the import is idempotent.
No automatic trace export runs in the background. Amp retains the original messages
and controls session execution. Use `trestle_call` with `tool: "coordination"` for
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
