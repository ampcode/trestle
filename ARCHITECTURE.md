# Trestle Architecture

## 1. What Trestle is

Trestle is a **knowledge graph harness**: a mini-application that owns the
**core data model** and **graph mechanics** of code comprehension and
migration, while pushing all domain knowledge — languages, grammars,
resolution rules, boundary heuristics — out to a customization surface the
user controls.

The design bet: migrations as different as mainframe decommission and Java
monolith modularization share the same skeleton —

```diagram
┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────────┐
│   Extract   │──▶│   Resolve    │──▶│   Project    │──▶│    Serve      │
│ facts from  │   │ identities   │   │ boundaries,  │   │ graph to      │
│ any corpus  │   │ corpus-wide  │   │ risk, search │   │ consumers     │
└─────────────┘   └──────────────┘   └──────────────┘   └───────────────┘
      ▲                  ▲                  ▲                   │
      │                  │                  │                   ▼
  user pipeline     user resolvers     projection plugins   agents, humans,
  (per profile)     (per profile)      (per profile)        orchestrators
```

— and only the plugged-in pieces differ per project. What happens *after*
serving — deciding units of work, binding them to agent threads, tracking
execution — is deliberately outside Trestle (§4–5).

## 2. Canonical ownership

Every kind of information has exactly one authoritative home. Consumers store
references, never copies. (Inherited directly from ampx; its strongest idea.)

| System | Canonical for |
|---|---|
| **Evidence graph** (Trestle store) | observed facts: nodes, edges, evidence records, provenance, source lineage |
| **Git** | desired state: ontology profiles, extraction pipeline and resolver code, skills, landed code |
| **External orchestrator** (e.g. ampx ledger) | live execution metadata: work units, thread bindings, statuses, reservations — outside Trestle entirely |
| **Amp** | conversations, execution, tool calls, verification output, artifacts, thread lifecycle |

Two rules follow:

1. **Do not create a second representation of another system's canonical
   data.** Trestle never stores execution metadata; orchestrators never store
   graph data — they hold at most a graph revision pointer and query the rest.
2. **Derived state is never persisted as truth.** Cluster membership,
   boundary candidates, and risk scores are recomputed from authoritative
   facts or stored as explicitly versioned projections.

## 3. Core data model

### 3.1 The meta-model: ontology as data

strangler-fig hard-coded `Program`, `Job`, `Dataset`, `CALLS`, `READS`, …
Trestle lifts that a level: node kinds, edge kinds, and fact kinds are
**declared in a Git-tracked profile**, validated at ingest time.

**Project standard: profiles are authored in TypeScript** and compiled to a
canonical JSON snapshot the engine ingests. The kernel never imports
`profile.ts`; `trestle profile build` evaluates it once and writes
`profile.lock.json`, whose content hash is the profile revision that serving
responses reference. `defineProfile` rejects functions anywhere in the tree —
vocabulary must evaluate to inert, serializable data; behavior belongs in
pipeline and resolver code. TypeScript is the authoring surface because the
whole user-space already is: the declared fact/node/edge schemas become
inferred types in the `trestle` SDK, so `emit("call-observed", …)` with
a typo'd kind or a missing required prop is a compile error in the editor,
not a runtime rejection mid-extraction.

```ts
// profile.ts (illustrative)
import { defineProfile, t } from "trestle"

export default defineProfile({
  nodes: {
    Program: { identity: ["qualifiedName"], props: { language: t.string(), loc: t.number() } },
    Dataset: { identity: ["normalizedPath"] },
  },
  edges: {
    CALLS: { from: ["Program"], to: ["Program"], props: { callType: t.enum("static", "dynamic") } },
    READS: { from: ["Program"], to: ["Dataset"] },
  },
  facts: {
    "program-defined": { version: 1, props: { name: t.string() } },   // neutral fact vocabulary, versioned
    "call-observed":   { version: 1, props: { callee: t.string(), argLiteral: t.string().optional() } },
  },
})
```

(Elsewhere in these documents, profile excerpts appear as YAML-ish shorthand
for brevity; the authored form is always TypeScript per this standard.)

The engine knows nothing about COBOL or Java. It knows:

- **Node** — `(kind, qualifiedName, localName, stableId, props)`. `stableId`
  is a content-derived logical key independent of storage UUIDs, enabling
  incremental refresh, snapshot diffing, and cross-revision lineage.
- **Edge** — `(kind, from, to, props)` plus **one or more evidence records**.
  Unlike strangler-fig (which merged evidence into a single edge row keeping
  max confidence), Trestle stores each observation separately:
  `(extractor, extractorVersion, sourceFile, locator, confidence, note)`,
  where a locator is a line span, byte range, record key, or time window.
  Merged confidence is derived at query time. Edge merge identity defaults
  to `(kind, from, to)`; an edge kind may declare an identity tuple of props
  (mirroring node identity) so context-distinct relationships — the same
  program reading the same dataset from two different job steps — remain
  distinct edges.
- **SourceArtifact** — original bytes, decoded text, byte + normalized
  hashes, encoding, lineage classification (canonical / mirror / historical /
  alternate). Inherited from strangler-fig's provenance tables.
- **GraphRevision** — every ingest produces a new revision; projections and
  verification evidence pin the revision they were computed against.

Uncertainty is first-class: a dynamic COBOL call, an unresolved reflection
target in Java, or an ambiguous dataset mapping stays in the graph as a
low-confidence edge with a classification — never silently dropped, never
promoted to fake certainty.

### 3.2 The fact bus

Parsers never write to the graph. They emit **versioned neutral facts** —
local observations about one file:

```
parser <source-path> <context-json>  →  { version, facts: [...] }  on stdout
```

The fact vocabulary is declared per profile (with a shared standard library of
common kinds: definitions, references, calls, data access, containment,
layout). The registry validates known kinds, rejects malformed ones, and
tolerates unknown newer kinds with warnings — so parsers and engine can
version independently.

Parsers are **external processes**: any executable in any language, run with
timeouts, output limits, and sandboxing, matched to files by profile rules
(include/exclude globs, file kind, options). This is deliberately not an
in-process plugin API — a COBOL parser written against a proprietary grammar,
a tree-sitter wrapper, an LLM-backed extractor for undocumented DSLs, and a
bytecode analyzer all satisfy the same contract. Each parser ships a small
manifest: name, version, declared fact kinds, checksum.

### 3.3 Resolvers: corpus-wide identity and edge derivation

Facts are local; knowledge is global. After all files are parsed, **resolver
passes** run with access to the full fact corpus and the graph built so far.
Resolvers are the pluggable generalization of strangler-fig's `LinkContext`
(which joined COBOL `ASSIGN TO DDNAME` through JCL step allocations — a join
no single-file parser could make).

A resolver declares:

```yaml
resolvers:
  - name: dd-name-resolution
    consumes: [file-control-observed, dd-allocated, program-executed]
    produces: { edges: [READS, WRITES] }
    run: ["node", "resolvers/dd-resolution.js"]   # or builtin: <name>
    phase: 20        # ordered passes; later phases see earlier output
```

Built-in resolvers cover the generic cases: qualified-name unification,
alias tables, copybook/include resolution, hash-based duplicate
classification. Project resolvers encode the proprietary knowledge — naming
conventions, in-house frameworks, config-file indirection, JNDI lookups,
Spring wiring, CICS transaction routing.

Resolvers may also emit **Claim** nodes — assertions that need human or agent
confirmation (e.g. "these 3 programs are behaviorally identical mirrors") —
which downstream orchestration can turn into review tasks.

The extract and resolve stages are specified in detail, with worked Java
monolith and mainframe→cloud examples, in
[EXTRACT-RESOLVE.md](./EXTRACT-RESOLVE.md). The kernel's simplicity claim is
stress-tested against twelve adversarial use cases in
[REGRESSION-SCENARIOS.md](./REGRESSION-SCENARIOS.md).

### 3.4 Projections: derived, versioned, explainable

Everything computed *from* the evidence graph is a projection, stored in a
separate layer stamped with `(graphRevision, algorithm, algorithmVersion,
params)`:

- **Boundary candidates** — weighted clustering (Louvain or pluggable) over a
  profile-declared weight model. Weights are configuration, not code:
  strangler-fig's insight that shared *mutable* state should weigh far more
  than shared read-only data, and that high-fan-in utility hubs must be
  discounted, becomes a default weight profile the user can override. Every
  membership records confidence and an assignment reason so a reviewer can
  challenge it.
- **Scheduling DAG** — the narrow set of edge kinds that affect readiness,
  for consumers that sequence work. The rich graph keeps its dozens of edge
  kinds; scheduling sees only `depends-on` and `conflicts-with`.
- **Search index** — text + vector projection over nodes/edges for agent and
  human exploration.
- **Cypher materialization** — the live graph slice materialized into an
  embedded Cypher engine and served through the portal MCP endpoint (§7.3).
  Never authoritative: regenerated from the store, rebuilt on profile change.
- **Snapshots** — deterministic `nodes.jsonl` / `edges.jsonl` + manifest +
  diagnostics keyed by stable logical IDs, for interchange and diffing.

Projections regenerate freely; boundaries proposed by clustering never
overwrite observed facts, and re-running with new params is cheap and safe.

### 3.5 Storage: system of record and revisions

The durable store is **SQLite, owned single-writer by the trestle server**.
All kinds share **one `nodes` table and one `edges` table** — no per-kind
tables, no per-kind physical columns:

```sql
CREATE TABLE nodes (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,          -- profile vocabulary
  identity    JSONB NOT NULL,         -- the identity tuple
  stable_id   TEXT NOT NULL,          -- hash(kind + canonical identity serialization)
  props       JSONB NOT NULL,         -- schema-validated at the write boundary
  provenance  TEXT NOT NULL,          -- 'stub' | 'declared'
  created_rev INTEGER NOT NULL,
  retired_rev INTEGER
);
CREATE UNIQUE INDEX nodes_live ON nodes (kind, stable_id) WHERE retired_rev IS NULL;
-- edges: kind, from_id, to_id, identity, stable_id, props, rev interval
```

Per-kind structure exists as data, not DDL: the profile snapshot drives
write-boundary validation (nothing undeclared or malformed enters the store),
and `trestle profile build` generates **partial expression indexes** for
identity fields and `indexed` props (`CREATE INDEX … ON nodes
(json_extract(identity,'$.name')) WHERE kind='Service'`). Users declare
columns; they never migrate tables. Identity fields are scalars, all
required, immutable, with normalization chosen from a fixed declarative menu.
Typing is enforced three times: compile-time via profile-inferred TS types,
runtime at the write boundary (the authoritative gate), storage only enforces
uniqueness.

**Revisions.** One monotonic counter for the whole project; a revision is a
commit — any atomic apply batch (pipeline fact apply, resolver directive
apply, alias merge, decision, profile activation) stamps
what it touched. Rows are immutable: every versioned entity carries
`created_rev`/`retired_rev`, update = retire + insert under the same
`stable_id`, uniqueness applies to live rows only. Consequences: the graph
at revision N is a WHERE clause; retirement is bulk and owner-scoped
(re-running a resolver atomically replaces exactly the rows whose evidence
names it); history is the audit trail. Full retention by default;
revision-range compaction is a later maintenance op, not a model weakening.

The full inventory: input side — `corpus_roots`, `artifacts` (content-
addressed + production fingerprint), `facts`, `memo_cells` (recorded reads →
surgical invalidation); graph side — `nodes`, `edges`, `evidence` (entity →
fact + `(resolver, version, rule)`: the retirement key and the trace to
bytes), `aliases`, `claims`, `decisions`; cross-cutting — `revisions`,
`profile_snapshots` (old revisions stay interpretable under their own
vocabulary), `runs`, `projections` (manifests pointing at regenerable
outputs). Directives have no table: their durable residue is evidence rows.

Invariants: append-only everywhere, judgment-deletion requires a decision
row; every write names its owner (cell, resolver+version+rule, author);
every row traces to bytes (node → evidence → fact → artifact → corpus
revision, all hops fingerprinted); derived data pins its revision and is
regenerable, or it belongs in `decisions` instead.

## 4. From graph to work: the consumer contract

Trestle ends at the graph. Turning graph sections into units of work, binding
them to agent threads, and tracking execution is an **external orchestrator's**
job (ampx is the reference consumer). What Trestle owes such consumers is a
small, stable read contract:

- **Revision-stamped results.** Every serving response (CLI `--json`, MCP
  tool result) names the graph revision — and, where known, the corpus commit
  — it was derived from. A consumer's verification claim ("acceptance held")
  is only meaningful relative to that stamp; a later extract that moves the
  revision detectably stales it. Trestle exposes the stamp; it never stores
  the claim.
- **Scoped queries.** Consumers address graph *sections* generically — an
  induced subgraph for a node set or selector, boundary-crossing edges,
  unresolved claims and stub nodes within a section — via `graph_query`,
  `survey`, and projection tools. Trestle has no privileged "unit" concept;
  a scope is just a selector.
- **Read-only consumption.** Consumers never write the graph. Graph writes
  happen only through `extract`/`resolve` runs in the project checkout. If an
  orchestrator wants its work units *represented in* the graph (Unit nodes,
  OWNS edges, acceptance queries), it does so in userland: declarations in
  Git are just another corpus, transcribed and resolved by an ordinary
  profile. The kernel stays vocabulary-free.
- **Boundary candidates stay disposable.** The projection layer emits
  machine-derived, explainable, regenerable boundary suggestions. Promoting
  a candidate to a committed work declaration is a human/orchestrator act
  that happens outside Trestle.

## 5. Orchestration: external by design

An earlier revision of this document specced an orchestration layer inside
Trestle (driver/unit-agent/worker roles, reserve→bind handshakes, a ledger
with CAS transitions, verification-gated completion). That design is
deliberately **not** implemented here: it duplicated ampx, which already owns
durable-thread bindings, unit statuses, reservations, worker records, and
broadcast. The spec survives in Git history if a native ledger is ever
warranted.

The division of labor:

| Trestle provides | Orchestrator owns |
|---|---|
| evidence graph + revisions | unit declarations and lifecycle |
| scoped queries, surveys, doctor | thread bindings, reservations, workers |
| boundary-candidate projections | status transitions, scheduling frontier |
| revision/commit stamps on results | verification claims and their freshness |
| MCP/CLI/plugin serving surface | communication (broadcast) between threads |

The integration pattern: a coordinator agent holding both tool surfaces
(Trestle's query tools and the orchestrator's ledger tools) syncs additively
from Git-declared work to ledger rows, updates the orchestrator's graph
revision pointer after each extract/resolve, and lets bound threads self-serve
scope, surveys, and acceptance queries against Trestle's portal. Ledger-only
drift is reported, never auto-deleted.

## 6. Customization surface

Four mechanisms, in increasing order of coupling:

1. **Profiles** (`profile.ts` → `profile.lock.json`, Git-tracked) —
   vocabulary (node/edge/fact kind schemas, identity tuples), entrypoints
   (extraction pipeline, resolver phases), and projection policies
   (clustering weight models, scheduling edge selection). Declarative
   wiring only — never behavior.
2. **User programs** — the primary surface for project-specific semantics;
   the user owns the entire path from artifact to graph entity, in two
   programs with one hard boundary (see EXTRACT-RESOLVE §1.6): the
   **extraction pipeline** (filtering, unit assembly, tool selection,
   acquisition, transcription → facts, built on the kernel primitives
   `corpus`/`acquire`/`run`/`memo`/`emit`) and **resolvers** (all inference
   → directives). Each side ships an SDK + template + skill so coding
   agents can write them quickly; the JSON contracts are the only
   requirement.
3. **Amp skills** (`.agents/skills/`) — procedural guidance for agent roles:
   how to write a profile, an extraction pipeline, a resolver; how this
   project's vocabulary maps to its domain. Expanded only in threads.
4. **Amp plugins** (`.amp/plugins/`) — the tool surface: the committed
   `trestle.ts` plugin gives any thread graph query tools (`trestle_auth`
   to authenticate against a project portal, `trestle_query` for raw
   Cypher, `trestle_call` for remote survey/status/doctor).

## 7. Runtime shape

Small, boring host:

- **TypeScript / Node**, no ORM.
- **Storage adapter** with two backends: SQLite per project (default —
  self-contained, one file, matches the "mini application" goal) and
  PostgreSQL (large corpora; unlocks HNSW vector search, trigram source
  search, and in-database AGE Cypher). Cypher serving is a projection
  behind its own engine adapter (§7.3), independent of this choice.
- **One authenticated endpoint** for graph-query operations, explicit decoder
  boundary for untrusted JSON, typed domain errors
  (`invalid_input | not_found | conflict` with reasons).
- **CLI** exposing pipeline stages independently:
  `trestle profile | extract | resolve | survey | status | doctor |
  project | serve | corpus add`.

### 7.1 Deployment: one orb per project

Trestle's unit of deployment is **one orb per migration project**. The orb
holds the project checkout, the SQLite store, and the trestle server, declared
in `.amp/services.yaml` and run as a supervised orb service (survives CLI
updates and orb pause/resume). `amp orb services ensure` starts it and prints
its public portal URL — the project's single access point.

```diagram
┌───────────────────── graph repo orb ──────────────────────────┐
│  checkout (trunk)      trestle server (orb service)           │
│  profile,           ┌────────────────────────────────────┐    │
│  pipeline,          │  /mcp   MCP (Streamable HTTP)      │    │
│  resolvers,         │  /      graph explorer             │    │
│  corpora/ (pinned   │  /health /ready                    │    │
│  submodules)        │                                    │    │
│  store (SQLite:     └────────────────┬───────────────────┘    │
│  facts+graph)                        │                        │
│  Cypher projection                   │                        │
│  (LadybugDB file)                    │                        │
└──────────────────────────────────────┼────────────────────────┘
                                       │  Amp portal (authn)
              ┌────────────────────────┼───────────────────────┐
              ▼                        ▼                       ▼
      orchestrator threads      analysis threads       humans, meta-agents,
      (e.g. ampx units)         (ad-hoc queries)       other tools
```

### 7.2 MCP through the portal

The primary remote query surface is an **MCP endpoint (Streamable HTTP) served
through the orb portal**. Any Amp thread — orchestrator threads, ad-hoc
analysis threads, even threads in other repos — attaches the portal URL
as a remote MCP server and gets the project's knowledge graph as tools, with
no project-local plugin required:

- **Graph tools (read-only):** `graph_query` (raw Cypher against the
  projection), `survey` (unresolved-population report), `status` (live
  counts), `doctor` (graph health checks).
- **MCP resources:** the profile and snapshot manifests exposed as readable
  resources so agents can cite exactly what they acted on.

**Portal authentication** gates transport. Signed-in browsers pass
interactively; non-browser clients (an agent thread's MCP client, curl in
another orb) redeem a single-use portal login URL, which sets a portal
session cookie. Serving is read-only: graph writes happen only through
`extract`/`resolve` runs in the project checkout, never over the wire.

The `.amp/plugins/` surface (§6) makes this ergonomic from any thread:
`trestle_auth` performs the login handshake once and stores the session;
`trestle_query`/`trestle_call` then hit the portal MCP endpoint directly.
Threads working inside the project orb can talk to localhost instead. Both
speak to the same server, so tool contracts stay identical.

### 7.3 Database runtime: SQLite of record, Cypher as projection

The system of record and the Cypher query surface are **different databases
with different jobs**, connected by the projection mechanism:

```diagram
SQLite (system of record)                    Cypher engine (projection)
┌──────────────────────────┐   materialize   ┌─────────────────────────┐
│ facts, evidence, nodes,  │────────────────▶│ per-kind node/rel tables│
│ edges, claims, decisions,│   at revision N │ generated from profile  │
│ revisions                │                 │ MATCH …-[:INVOKES]->…   │
└──────────────────────────┘                 └───────────┬─────────────┘
        ▲                                                │ Cypher
        └─ writes (pipeline, resolvers, decisions)       ▼
                                                /mcp portal endpoint
```

The interval-versioned, evidence-joined work is
relational-shaped; SQLite in a single-writer orb does it well. Cypher
serving is a **regenerable projection**: the live slice (`retired_rev IS
NULL`) materialized into an embedded engine. This inverts two constraints:
per-kind typed tables — rejected for the store because vocabulary changes
would mean data migrations — are fine in a projection (profile changed →
drop the file, rebuild; `trestle profile build` emits the engine DDL, so
the Cypher schema *is* the profile), and engine risk is contained (swapping
engines is a cache rebuild, zero data loss). Time travel falls out: "the
graph as of revision N" is a projection materialized at N.

Engines are pluggable behind a four-operation adapter — `provision(profile)`,
`loadFull(rows, rev)`, `applyDelta(delta)` (optional; fallback is rebuild),
`endpoint()` — with correctness defined mechanically: *projection at N equals
full rebuild at N*, verified by a shared conformance suite (one graph
fixture, one query set, results compared across adapters). Two adapters are
committed:

- **LadybugDB** (default) — the maintained MIT fork of the archived Kuzu
  project: embedded, in-process file, zero services, columnar/analytical,
  `COPY FROM` Parquet bulk loads. Fits the one-orb-per-project model.
- **Neo4j** (alternative) — runs as a second orb service over Bolt; labels +
  generated constraints instead of typed tables. The right pick for
  Browser/Bloom visualization, organizational Neo4j expertise, or APOC/GDS
  algorithms. Community edition is GPLv3 — fine to run, not redistributed.

The projection manifest and the `/mcp` tool description advertise engine,
dialect, and pinned revision as data, so querying agents know what they are
talking to. Shipped tooling (surveys, starter queries) sticks to the
openCypher-portable core so it runs on both. Extensibility is the adapter
contract itself, not a compatibility matrix. At scale-out (multi-writer,
hundreds of millions of rows), the storage-adapter seam swaps SQLite for
Postgres — where Apache AGE can serve Cypher in the same database — under
the same logical contract.

**The standard deployment shape: the trestle repo IS the graph repo.** A
trestle project is a fork (or clone) of this repository. The engine
(`src/`), the CLI (`bin/`), the agent context (`.agents/`), and the
project-owned user surface (`profile.ts`, `extract/`, `resolvers/`,
`corpora/`) live side by side in one repo the user runs in their own
environment. There is no separate install, no npm registry, no `trestle
init`, and no scaffold machinery: every clone is already initialized —
`.agents/setup` bootstraps the environment (orbs run it automatically) and
the loop commands work immediately.

Git is both distribution and upgrade. New engine versions arrive by merging
upstream (`git remote add upstream https://ampcode.com/@jesse/trestle; git
fetch upstream; git merge upstream/main`); project-owned files rarely
conflict with engine files because they occupy disjoint paths.

The estates under analysis are pinned shallow submodules under `corpora/`
(`trestle corpus add <git-url>`), which buys three things: the graph is
naturally multi-repo (an enterprise migration rarely stops at one repo);
the gitlink SHA of each submodule is corpus provenance for free — the graph
repo's history records exactly which estate revision every fact was
transcribed from; and the analyzed repos stay untouched — no
`node_modules/`, no build edits, no PR against a codebase whose owners
didn't ask for one. Source paths self-namespace as `<corpus-name>/…`
because each estate is a named subdirectory of the single corpus root
(`corpusRoots: ["corpora"]`). Regular filesystem and search tools work
inside initialized submodules, so agents navigate the corpus like any
checkout. Embedding trestle inside the analyzed repo remains possible
(`corpusRoots: [".."]` and legacy `trestle/` directories still resolve),
but it is an escape hatch, not a documented peer mode.

```
<graph repo root>              # a fork of the trestle repo
  package.json                 # name "trestle", private; self-reference exports ./src/index.ts
  tsconfig.json
  AGENTS.md                    # agent operating instructions (committed)
  trestle.config.ts            # engine config: corpus roots, storage, service/portal
  profile.ts                   # vocabulary entrypoint (may import ./profile/*.ts fragments)
  profile.lock.json            # committed canonical snapshot; hash = profile revision
  extract/pipeline.ts          # the extraction pipeline entrypoint (user-owned)
  resolvers/*.ts               # resolver programs (user-owned)
  corpora/<name>/              # one pinned shallow submodule per estate (read-only)
  bin/trestle.js               # CLI entrypoint
  src/                         # the engine (upstream-owned; upgraded by merge)
  tests/                       # engine tests
  .state/                      # gitignored: local fact store cache, frozen artifacts, snapshots
  .amp/services.yaml           # trestle serve as a supervised orb service + portal
  .amp/plugins/                # trestle.ts: graph query tools (auth, Cypher, survey/status/doctor)
  .agents/setup                # bootstrap: Node >= 23.6 check, submodule init, npm install
  .agents/skills/              # trestle-* skills (committed) + project skills
```

**No package boundary.** User files import the SDK by the package
self-reference (`import { pipeline, resolver } from "trestle"` — Node
resolves the repo's own `package.json` `exports` to `./src/index.ts`, type
stripping the source directly). The package is `"private": true`; nothing is
published. The four surfaces are repo directories, not package exports:

1. **Runtime + CLI** — `src/` + `bin/trestle.js`:
   `trestle profile build/check | extract | resolve | survey | status |
   doctor | project | serve | corpus add`.
2. **SDK** — the `"trestle"` self-reference: profile builders
   (`defineProfile`, `t.*`), the five extraction primitives
   (`corpus`/`acquire`/`run`/`memo`/`emit`), the resolver SDK and kit.
3. **User surface** — `profile.ts`, `extract/pipeline.ts`, `resolvers/*.ts`
   ship as small running examples (a file-inventory fact emitter, a P0
   mapping resolver) meant to be edited into the real pipeline; the
   type-checker catches upgrade breaks after a merge.
4. **Agent context** — `AGENTS.md` (the extract→resolve→survey loop,
   pointers to skills, the corpora-are-read-only rule, a Project-notes
   section), `.agents/skills/` (four semantics-first skills:
   profiles, extraction, resolvers, loop — shipped as ordinary repo
   files, discovered natively by the agent), and `.amp/plugins/trestle.ts`.
   Context is version-matched by construction: it lives in the same
   commit as the engine it describes.

*Environment bootstrap*: `.agents/setup` (Node ≥ 23.6 check, shallow corpus
submodule init, `npm install`). Orbs run it once in a fresh sandbox and
snapshot the result; a stale snapshot re-runs it on a warm filesystem, so
the script is idempotent and fast when `node_modules` and submodules
already exist.

*Serving*: `.amp/services.yaml` declares `trestle serve` as a supervised
orb service with a portal, so `amp orb services ensure` exposes the graph
MCP endpoint to other threads.

This shape trades multi-project version pinning for radical simplicity:
one repo, one commit, engine and project always consistent, no publish
step, no version skew between skills and runtime. An agent pointed at a
fresh clone has running example code to imitate, typed contracts to
satisfy, version-matched skills that teach the loop, and a survey that
tells it what to do next.

Engine internals (not user-facing):

```
src/
  profile/      # defineProfile, t.* schema builders, lock build/load, prop validation
  store/        # SQLite store: revisions, facts, nodes, edges, evidence, aliases,
                #   claims, memo cells; applyDirectives (atomic revision + retirement)
  extract/      # pipeline runner: memoized cells, corpus walking, acquire/run, fact emission
  resolve/      # resolver SDK (slice/emitter), kit (rules/mapFacts), phase-ordered runner
  survey/       # unresolved-population report over facts/nodes/edges/claims
  check/        # doctor: graph health checks (duplicates, orphans, hygiene)
  project/      # Cypher projection (LadybugDB materializer)
  server/       # MCP serve endpoint (graph_query, survey, status, doctor)
  cli/          # profile build/check, extract, resolve, survey, status,
                #   doctor, project, serve, corpus add
```

## 8. Use-case mapping

**Mainframe modernization / decommission.** Profile ≈ strangler-fig's:
COBOL/JCL/BMS parsers, DD-name and copybook resolvers, mutable-dataset-heavy
weight model. Trestle adds what strangler-fig stopped short of: boundary
candidates as reviewable projections that an external orchestrator can
promote to units of work, and decommission tracking as a projection (which
programs/datasets have no remaining live inbound edges).

**Legacy/proprietary code mapping.** The degenerate but important case:
extraction and resolution only, orchestration optional. Tolerant island
parsers (parse what you understand, skip the "water"), LLM-backed extractors
as ordinary fact-emitting parsers with low-confidence evidence, Claim nodes
for human confirmation, search + graph UI as the deliverable. The evidence
model is the product here: provenance and confidence make a partially
understood map honest and incrementally improvable.

**Java monolith modularization.** Parsers over source + bytecode + build
files; resolvers for Spring wiring, JNDI, reflection, JPA entity→table
mapping; weight model penalizing shared mutable entities and transaction
boundaries; boundary candidates = candidate modules with `conflicts-with`
edges where scopes overlap. Strangler routing state (what traffic has
moved) is a projection over deployment facts.

## 9. Decisions and rejected alternatives

Adopted (with source):

- Neutral versioned fact bus; external-process parsers *(strangler-fig)*
- Two-stage parse → corpus-wide resolve *(strangler-fig, generalized to
  pluggable resolver passes)*
- Multiple evidence records per edge; confidence derived at query time
  *(strengthened from strangler-fig's single merged row)*
- Evidence vs. projection separation; explainable membership *(strangler-fig)*
- Relational canonical store (SQLite, single-writer, interval-versioned
  rows, one nodes/edges table for all kinds); Cypher served from a
  regenerable projection behind an engine adapter — LadybugDB default,
  Neo4j alternative, Postgres+AGE at scale-out (§3.5, §7.3). Rejected:
  graph DB as system of record — bitemporal bookkeeping and evidence joins
  are relational-shaped, and per-kind typed tables in the
  store would turn vocabulary changes into data migrations
  *(strangler-fig, strengthened)*
- Single canonical owner per information kind; pointers not copies *(ampx)*
- Orchestration mechanics (unit binding, reservation, verification-gated
  completion, trunk integration) delegated wholesale to the external
  orchestrator rather than reimplemented *(ampx as reference consumer, §5)*

Rejected:

- **Closed ontology in code** — becomes profile data. The engine validates
  shape, not vocabulary.
- **In-process parser plugin API** — process boundary is the plugin API.
- **Workflow engine / saga orchestration** — every graph state is
  reconstructible from Git-tracked user code + the revisioned store; no
  hidden execution state.
- **In-kernel orchestration (units, bindings, statuses, frontier)** — a
  full spec existed and was deliberately not implemented; it duplicated
  ampx's canonical data. Trestle serves the graph; orchestrators own work.

## 10. Open questions

- **Incremental ingest.** The mechanism is implemented (memo-cell input
  fingerprints → surgical fact retirement; owner-scoped directive
  retirement; delta-driven re-resolution per §2.3 of EXTRACT-RESOLVE) and
  held up on the OFBiz dogfood (~42k facts), but larger estates are
  unproven.
- **Evidence freshness granularity.** Commit + graph revision on verification
  pointers is coarse; tying invalidation to the unit's declared scope paths is
  the pragmatic middle ground, but scope drift makes it imperfect.
- **Profile evolution.** For the graph, settled: it is derived, so schema
  change = re-resolve from facts under the new profile (§3.5); `trestle
  profile check` lints the store and reports violations as data. Still open
  for the durable layers: changing a *fact kind's* schema (re-transcribe
  from artifacts, guided by per-kind `version`) and identity-rule changes
  that shift `stable_id`s under external consumers pointing at them.
- **Multi-repo corpora.** Mainframe estates and monolith split-targets often
  span repositories; the profile and provenance model should treat "corpus"
  as a set of roots, but the current implementation assumes one root
  checkout.
