# Extract & Resolve: Detailed Scope

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) §3.2–3.3. This document pins
down the two evidence-producing stages — **extract** (indexing: per-parse-unit
facts, see §1.5) and **resolve** (corpus-wide identity and edge derivation) —
and works both through two full examples: Java monolith decomposition and
mainframe→cloud migration. The full lifecycle is **acquire → index →
resolve → project**; acquisition (fetching hosted inputs into immutable
snapshot artifacts) is covered in §1.5.

The dividing line between the stages is strict:

> **A parser transcribes what its declared inputs literally contain — it
> never infers. All inference, joining, and graph writing belong to
> resolvers.**

The line is *transcription vs. inference*, not single-file vs. multi-file. A
parser reading a SCIP index may faithfully transcribe a cross-file
reference the indexer already resolved — that's still transcription, because
the conclusion is literally present in the artifact. What a parser may never
do is *conclude* something its inputs don't state. This is what makes parsers
simple, polyglot, and independently testable, and concentrates all the clever
(and project-specific) joining logic in resolvers.

---

## 1. Extract stage

Extraction is **user code**. Trestle does not own file matching, filtering,
unit assembly, or tool selection — the project ships an **extraction
pipeline**: any executable (typically TypeScript against the `trestle`
SDK) that decides how artifacts become facts. Which files
matter, which tool parses them, what constitutes a parse unit, what happens
in what order — all plain code (loops, ifs, queries over earlier facts),
never engine configuration. The engine contributes five primitives that make
whatever the pipeline does deterministic, incremental, and auditable:

| Primitive | What it does | Guarantee |
|---|---|---|
| `corpus.list()` / `corpus.read(p)` | enumerate / read corpus artifacts | every read is recorded; content hashes feed cache keys |
| `acquire(name, fetch)` | fetch remote inputs (hosted SCIP index, API harvest) | the **only** primitive allowed network; result frozen as an immutable snapshot artifact with `asOf` |
| `run(tool, args, inputs)` | invoke an external tool (clang, javac, tree-sitter, scip) | sandboxed, offline; covered by the fingerprint seed, which hashes every file under `extract/` (pipeline code and helper tools) plus the profile — an upgraded external binary is invisible, so encode its version in the cell name |
| `memo(name, inputs, fn)` | an incremental cell | body skipped when the input fingerprint is unchanged; facts from a recomputed cell retire their predecessors. `inputs` must be corpus paths (or `acquire` results) — version/tool identity goes in the cell name, not `inputs` |
| `emit(facts)` | write facts to the fact store | envelope enforced, schema-validated at the write boundary |

The engine never contains a format, language, or framework name — and after
this change, it also never contains a *policy* about which files are
interesting. "Acquirer", "assembler", and "parser" survive as **patterns**
the SDK has helpers and templates for, not as kernel-scheduled roles.

### 1.1 Parser contract

A parser is any executable:

```
<parser-cmd> <source-path> <context-json-path>
```

- reads one source artifact (or artifact-like input: a catalog listing, a
  scheduler export, a runtime trace — anything file-shaped);
- writes one JSON document to stdout:

```jsonc
{
  "parser": "java-source",
  "parserVersion": "1.4.0",
  "factSchemaVersion": 1,
  "sourcePath": "src/main/java/com/acme/billing/InvoiceService.java",
  "facts": [ /* see 1.3 */ ],
  "diagnostics": [
    { "level": "warn", "message": "unbalanced braces after line 412; skipped to next type", "line": 412 }
  ]
}
```

The context JSON carries whatever the pipeline chooses to pass: options,
declared file kind, encoding, corpus root, the unit's content hashes.
Parsers must be deterministic functions of their explicit inputs — no
network, no clock, no scanning sibling files. The pipeline invokes them via
`run`, which is what enforces that discipline.

**Parse units are pipeline decisions.** By default a parse unit is one
artifact. For languages where one file cannot be parsed alone (C/C++
preprocessing, Java annotation processing, TypeScript project references,
COBOL copybooks), the pipeline *assembles* the unit itself — plain code that
queries facts it already emitted (a parsed `compile_commands.json`, a JCL
SYSLIB order, a listing index) and hands the tool the complete unit. *How*
headers map to `.c` files or copybooks to programs is semantics and lives in
the pipeline; the engine's contribution is mechanical: `memo` fingerprints
the whole unit, so a changed header re-parses exactly the cells whose
declared inputs contain it.

A parser meant for reuse across projects ships a **manifest**
(`parser.yaml`): name, version, command, declared fact kinds + versions,
runtime requirements, checksum — so profiles can share and pin them. But the
authoritative gate is the write boundary: `emit` refuses facts whose kind or
shape the profile's schemas don't declare, no matter what produced them.

### 1.2 Execution model

The engine executes the pipeline as a **tracked computation**:

1. the pipeline runs sandboxed; `corpus.read`, `run`, and `acquire` record
   every input they touch (content hashes, tool fingerprints, snapshot
   identities);
2. each `memo` cell is keyed by the fingerprint of its recorded inputs —
   unchanged inputs skip the cell entirely; changed inputs recompute it and
   retire the facts the old cell emitted;
3. a crashing cell fails that *cell*, not the run — diagnostics attach to
   the cell's artifacts and the rest of the corpus proceeds;
4. `emit` validates each fact against the profile's declared kind schemas —
   malformed known kinds are rejected with diagnostics, unknown newer kinds
   pass through with warnings (tools and engine version independently);
5. validated facts persist in the **fact store**, keyed by emitting cell.

Persisting facts is a deliberate scope decision: resolvers can be re-run,
re-ordered, and added **without re-extraction**, and an incremental run
recomputes only cells whose input fingerprints changed.

### 1.3 Fact envelope and standard library

Every fact shares an envelope:

```jsonc
{
  "kind": "call-observed",
  "version": 1,
  "locator": { "type": "lines", "startLine": 88, "endLine": 88 },  // within sourcePath
  "confidence": 1.0,                            // parser's local certainty only
  "authority": { "tool": "scip-java", "version": "0.10.4", "asOf": "2026-08-12" },  // optional
  "props": { /* kind-specific, schema-validated */ }
}
```

**`authority` (optional).** Present when the fact transcribes another tool's
*conclusion* rather than the parser's first-hand observation of source — a
SCIP indexer's resolved reference, a compiler listing's cross-reference, a
linker map's binding. Absent means the parser observed it directly. The field
feeds three mechanisms downstream: corroboration ranking (compiler-authority
evidence outranks source heuristics), staleness (the authority's `asOf` is
the analysis date to compare against artifact hashes), and audits ("which
edges rest *only* on borrowed conclusions with no first-hand corroboration?").

Locators generalize beyond text. Line spans are the common case, but evidence
from binaries, trace exports, and operational logs needs other forms:

```jsonc
{ "locator": { "type": "lines",  "startLine": 88, "endLine": 92 } }
{ "locator": { "type": "bytes",  "start": 18744, "end": 18892 } }
{ "locator": { "type": "record", "key": "SMF:2026-07-14:seq=88213" } }
{ "locator": { "type": "window", "from": "2026-07-01", "to": "2026-07-31", "count": 1422 } }
```

Trestle ships a **standard fact library** covering what most codebases need —
profiles use it as-is, extend it, or add custom kinds:

| Std fact kind | Meaning |
|---|---|
| `unit-defined` | a named definable thing exists here (program, class, job, map…) with its declared kind |
| `member-defined` | a contained definition (method, paragraph, step, field) |
| `call-observed` | an invocation site: callee name/expression, dispatch class (`static`, `dynamic`, `virtual`, …) |
| `reference-observed` | a non-call name reference (import, include, type use, symbolic ref) |
| `data-access-observed` | read/write/update/delete against a named data target, with access path detail |
| `layout-defined` | a physical or logical record/type structure with fields |
| `include-observed` | textual or compiled inclusion of another artifact by name |
| `binding-observed` | a configuration binding: key → value/target (DD card, Spring property, env var, deployment descriptor entry) |
| `execution-observed` | one artifact causes execution of a named unit (JCL EXEC, scheduler entry, main-class manifest) |
| `annotation-observed` | structured metadata attached to a definition |

Local certainty vs. global certainty: a parser reports `confidence: 1.0` for a
dynamic `CALL WS-PROG` — it is *certain the call site exists*. Whether the
callee is resolvable is the resolver's judgment and lands on the edge's
evidence records, not the fact.

### 1.4 Compiler and build output as artifacts

Compiler output is often the highest-fidelity evidence available — the
compiler already resolved what heuristic source parsing can only guess at.
Two distinct cases, with different mechanics:

**Case 1: pre-existing output in the corpus.** Treat it as an ordinary
artifact with a dedicated parser. This needs no new mechanics and is
sometimes the *only* evidence:

- **JVM bytecode** — already the Java profile's precision anchor (§3.2).
- **COBOL compile listings** — gold on mainframe estates: the 1987 compiler
  already expanded every COPY, computed every data-item offset, built a full
  symbol cross-reference, and resolved static calls. A `compile-listing`
  parser recovers all of that even when the build environment no longer
  exists:

  ```jsonc
  { "kind": "call-observed", "version": 1,
    "locator": { "type": "lines", "startLine": 3411 },   // in the listing
    "confidence": 1.0,
    "props": { "caller": "ACCT01", "callee": "ACCT9M",
               "resolvedBy": "compiler-xref", "compileDate": "1994-03-02" } }
  ```

- **Load modules / binaries** — CSECT scans, DWARF/PDB debug info, linker
  maps: program inventory and call graphs for source-lost estates (regression
  scenario 6), using byte-range locators.
- **JS sourcemaps** — the mapping artifact that joins minified bundles back
  to source.

**Case 2: output regenerated during extraction.** A parser's manifest may
declare a **pinned toolchain** (compiler + exact version + flags). The parser
invokes it — `gcc -E` for preprocessed units, `gcc -MMD` for dependency
lists, `javac` with a plugin, `clang -ast-dump=json` — and parses the result
in one step. Determinism is preserved because the toolchain fingerprint joins
`parserVersion` in the fact-store cache key: same artifact closure + same
toolchain → same facts. No network, no system compiler drift — the manifest
checksum covers the toolchain binary.

**Ordering is control flow.** Build metadata output solves scenario 5's
open question — where unit assembly gets include paths — simply by being
parsed *first*, and "first" is nothing more than the pipeline's own control
flow. There is no engine concept of rounds:

```ts
// extraction pipeline sketch — plain code, no engine scheduling vocabulary
const cc = await memo("compile-commands", [ccJson], () =>
  parseCompileCommands(corpus.read(ccJson)));

for (const tu of cc.units) {
  await memo(`c-ast:${tu.file}`, [tu.file, ...tu.headers], async () => {
    const ast = await run("clang", ["-ast-dump=json", ...tu.flags], [tu.file, ...tu.headers]);
    emit(transcribeClangAst(ast, tu.file));
  });
}
```

The same shape lets a mainframe listing index drive copybook resolution, or
a Maven dependency report drive classpath assembly. Tools invoked by `run`
stay single-shot and deterministic; sequencing, fan-out, and what depends on
what are the pipeline author's ordinary programming decisions.

**Lineage and staleness.** Compiled output is *derived from* source, and the
two can disagree — a `.class` file compiled before the last source commit, a
listing from 1994. The profile records `COMPILED_FROM` edges between artifact
nodes (same mechanism as codegen's `GENERATED_FROM`, regression scenario 4),
and a builtin `artifact-staleness` resolver compares hashes/dates along those
edges. Evidence from stale output is **downgraded, not discarded** — a 1994
listing is still excellent evidence for code untouched since 1993. Where
fresh source analysis and compiler output *conflict* (listing says the CALL
resolves to X, source parse says Y), the resolver files a claim instead of
picking a winner: a conflict is a fact about the corpus (stale build?
missing source version?) that a human or agent should see.

The confidence layering generalizes what §3.3's `call-resolution` already
does with bytecode: compiler-resolved evidence outranks source heuristics,
both attach to the same edges as separate evidence records, and query-time
confidence derivation sees the full picture.

### 1.5 Indexing: first-hand and adopted indexes

Extraction **is** indexing. The fact store is Trestle's own index of the
corpus — parsers don't feed an index, they *are* indexers. Seen that way,
there is no special "index parser" shape; there are just two **provenance
modes** for the same contract (§1.1), same envelope (§1.3), same caching:

- **First-hand indexer** — observes artifacts directly (source files,
  possibly assembled into closures per §1.1). `authority` absent. Examples:
  java-source, cobol-island, jcl. A plain AST (tree-sitter, ANTLR) is an
  implementation detail *inside* one of these — syntax over one parse unit,
  no cross-file binding.
- **Adopting indexer** — another tool already indexed the corpus; the
  indexer transcribes that foreign index into the fact envelope.
  `authority` present, naming the tool. Examples: SCIP index, compile
  listing, linker map, typed/attributed AST dump (javac attributed trees,
  Roslyn semantic model, `clang -ast-dump=json` — compiler *output*, not
  syntax; pre-existing dumps are §1.4 case 1, regenerated ones case 2).

Adoption is **transcription, not re-derivation**: nothing is computed
twice; the foreign index is normalized into the one neutral store in a
single cached pass. Trestle deliberately does *not* mount or query foreign
indexes in place — a single store with one envelope is what keeps resolvers
uniform, snapshots deterministic, and corroboration possible (a SCIP
conclusion and a first-hand source observation can attach to the same edge
as separate evidence records).

**Acquisition.** Parsers are deterministic and offline, so a *hosted* index
(e.g. a SCIP index on a Sourcegraph instance) enters through an explicit
**acquire step** — the one lifecycle stage allowed to touch the network. An
acquirer fetches and materializes an immutable snapshot artifact (the raw
`index.scip`, or a harvest JSON with an `asOf` stamp), and indexing proceeds
from that artifact like any other. Prefer acquiring the raw index file:
Sourcegraph's GraphQL API re-exposes only a serving-layer subset (it drops
read/write access roles, relationship flags, symbol kinds, and enclosing
ranges), so an API harvest is the fallback, not the default. The lifecycle
is therefore: **acquire → index → resolve → project**.

**Coverage as data.** A foreign index literally lists the documents it
covers, so the adopting indexer transcribes per-document coverage facts;
first-hand coverage is already derivable from the fact store's cell keys.
A survey over both answers "which
corpus regions have precise coverage, from which tool, at what freshness" —
no new kernel mechanics.

The invariant that keeps this coherent: **indexers emit facts, never nodes
or edges** — regardless of provenance mode. A SCIP-transcribed reference
goes onto the fact bus like any other observation; identity unification,
corroboration against first-hand facts, and staleness checks all still
apply. The graph never contains an edge that bypassed resolution — even
when the evidence came pre-resolved.

### 1.6 Who owns what: kernel mechanics vs. user code

The split is now maximally simple. **The user owns the entire path from
artifact to graph entity**, in two programs with one hard boundary between
them:

| User code | Owns | May not |
|---|---|---|
| **Extraction pipeline** | filtering, matching, unit assembly, tool selection, acquisition, transcription → `emit(facts)` | infer, or write to the graph |
| **Resolvers** | all inference and joining → directives (nodes, edges, aliases, claims) | touch artifacts or the network |

The kernel owns only mechanics, identical for both: recorded reads, content
hashing, memo-cell fingerprinting and fact retirement, sandboxed offline
execution, schema validation at the write boundaries (`emit` for facts,
directives for the graph), and the stores. The kernel never contains a
format name, a language name, a framework name, or a policy about which
files are interesting.

The profile shrinks accordingly: it declares **vocabulary** (node/edge/fact
kind schemas, identity tuples), **entrypoints** (the extraction pipeline,
resolver phases), and **policies** (acceptance, weights, budgets). It no
longer contains parser rules, globs, or rounds — those were behavior, and
behavior belongs in the pipeline.

"Acquirer", "assembler", "first-hand parser", "adopting indexer" remain as
**SDK patterns**: the `trestle` root export ships envelope and locator
builders, authority stamping and coverage-fact helpers, pinned-toolchain
wrappers around `run`, a manifest scaffold for shareable parser tools, and a
golden-fixture test runner, plus a `building-extraction` skill — so writing
a pipeline is a template exercise for a coding agent, not a research
project. The SDK is convenience, never contract: any executable emitting
valid envelopes through the write boundary is a full citizen.

**Foreign indexes are ordinary parser output.** A SCIP index, a ctags file,
a compiler's symbol dump — these get no special engine support. The pipeline
acquires or regenerates the artifact (`acquire` a hosted index, or a pinned
`run` of scip-java/scip-typescript), then a user-space transcriber walks it
and emits declared facts with `authority` stamping, exactly like any
first-hand parser. Mapping its symbols onto the project's vocabulary is the
project's resolver code. The extraction skill's tool index routes agents to
these indexers when the ecosystem warrants it; if ingesting one ever needs
an engine change, the kernel has failed its regression test.

---

## 2. Resolve stage

### 2.1 Resolver contract

Resolvers run after all parsing completes, in ordered **phases**. A resolver
declares what it consumes and produces:

```yaml
resolvers:
  - name: spring-wiring
    phase: 20
    consumes:
      facts: [annotation-observed, binding-observed, unit-defined]
      graph: { nodes: [Class, Bean], edges: [DEFINES_BEAN] }   # from earlier phases
    produces:
      nodes: [Bean]
      edges: [INJECTS, DEFINES_BEAN]
      claims: true
    run: ["node", ".trestle/resolvers/spring-wiring.js"]        # or builtin: <name>
```

Execution: the engine materializes the consumed facts (JSONL, one file per
kind) and a read-only snapshot of the consumed graph slice, writes a context
JSON with their paths, and invokes the resolver. The resolver writes a single
output JSONL stream of **directives**:

```jsonc
{ "op": "node",  "kind": "Bean", "qualifiedName": "billing.invoiceService", "props": { … } }
{ "op": "edge",  "kind": "INJECTS", "from": "Class:com.acme.OrderFlow", "to": "Bean:billing.invoiceService",
  "evidence": { "sourcePath": "…/OrderFlow.java", "span": {"startLine": 31}, "confidence": 0.95,
                "note": "@Autowired by type; single candidate" } }
{ "op": "alias", "canonical": "Program:ACCT01", "alias": "Program:PGM=ACCT01" }
{ "op": "claim", "kind": "ambiguous-injection", "about": ["Class:com.acme.OrderFlow"],
  "detail": "3 beans implement PaymentGateway; no @Qualifier", "candidates": ["…"] }
```

Directive semantics:

- `node` / `edge` — **upserts**. Edge endpoints **auto-vivify**: naming a
  node that doesn't exist yet creates a stub marked `provenance: stub`, so
  resolvers never have to order node emission before edge emission and an
  edge to a not-yet-enriched target is never an error. Explicit `node`
  directives are for *enrichment* (declaring props, reifying a concept) and
  set `provenance: declared`; a later declaration upgrades a stub in place.
  Stubs remaining after all phases are themselves queryable ("what do we
  reference but know nothing about?"). Edges accumulate evidence records; they never
  replace earlier evidence. Confidence is derived at query time from the
  evidence set. Edge merge identity defaults to `(kind, from, to)`; an edge
  kind may declare an **identity tuple** of props (mirroring node identity),
  in which case differing identity-prop values are distinct edges — how the
  same program reading the same dataset from two different JCL steps stays
  two edges instead of silently merging.
- `alias` — identity unification: the engine merges the alias's observations
  into the canonical node (JCL's `PGM=ACCT01` and COBOL's `PROGRAM-ID.
  ACCT01` become one node). Alias directives are recorded, so unification is
  auditable and reversible on re-resolve.
- `claim` — an assertion needing confirmation, materialized as a Claim node.
  Claims are the honest-uncertainty escape valve: instead of guessing, a
  resolver files a structured question that orchestration can route to an
  agent or human, whose answer comes back as a Git-tracked **decision file**
  consumed by a later resolve run.

**Provenance and retirement.** Every directive is recorded with its
provenance: `(resolver, resolverVersion, rule)`. Re-running a resolver
atomically **replaces its own prior contribution** — evidence records,
stub nodes, aliases, and claims it emitted before are retired and its new
output applied — while other resolvers' contributions to the same nodes and
edges are untouched. This is what makes resolution safe to iterate at
scale: a fixed rule never leaves ghost edges behind, and `trestle resolve
--diff` can show exactly what a resolver change does to the graph before
it's accepted.

Resolvers must be deterministic and idempotent — re-running a phase against
the same facts and upstream graph yields the same directives. That makes the
whole resolve stage safely re-runnable as resolvers improve.

### 2.2 Phase conventions

Phases are just ordered integers; the conventions below keep profiles legible:

| Phase | Purpose |
|---|---|
| 10 | identity: name normalization, alias unification, duplicate/mirror classification |
| 20 | structural joins: the links parsers couldn't make (DD-names, bean wiring, includes) |
| 30 | semantic enrichment: data mapping, transaction boundaries, routing |
| 40 | inference: dynamic-target resolution, convention-based joins, claims |
| 50 | corroboration: runtime/operational evidence raising or lowering confidence |

Built-in resolvers (engine-provided, configured not coded): qualified-name
unification, include/copybook resolution by name+content-hash, duplicate
lineage classification (canonical/mirror/historical), decision-file
application (turns answered claims into edges).

Semantic resolvers are programs, but they are built from eight universal
primitives shipped as an SDK, follow one standard template, and are usually
authored by coding agents following the `building-resolvers` skill — see
[RESOLVER-KIT.md](./RESOLVER-KIT.md) for the primitives, the SDK, the
template, and the project bootstrap path built on them.

### 2.3 Resolution at scale

Three mechanics keep resolve tractable when the fact store holds millions
of rows — all engine mechanics, no vocabulary:

- **Partitioned materialization.** A resolver's `consumes` declaration may
  add join keys (`facts: [{ kind: call-observed, joinOn: props.callee }]`).
  The engine materializes consumed facts partitioned and sorted by those
  keys, so a P1 binding join streams two cursors instead of loading the
  corpus into memory, and a P0 mapping streams one. Resolvers that declare
  no join keys still get per-kind JSONL — they just scale worse, which is
  their author's choice to make.
- **Delta-driven re-resolution.** Extraction is already incremental (memo
  cells); resolution extends the same tracked computation: when cells
  retire and re-emit facts, the engine re-runs only resolvers whose
  consumed kinds changed, in phase order, and provenance retirement (§2.1)
  makes each re-run a clean replace. A resolver may additionally declare
  itself **partition-safe** (its output for partition K depends only on
  facts in K), letting the engine re-run just the affected partitions —
  the common case for P0/P1/P2 resolvers; fixpoint resolvers (P4) stay
  whole-graph.
- **Bulk application.** Directives are a JSONL stream; the engine applies
  them in batches — alias unification via union-find over the whole batch,
  evidence appends and upserts as bulk writes — rather than
  row-at-a-time graph mutation.

---

## 3. Worked example A: Java monolith decomposition

Goal: enough graph fidelity to derive module boundaries, which means the
things that make monoliths hard to split must be *visible as edges*: hidden
coupling through the database, Spring wiring, shared mutable state,
transaction boundaries, and reflection.

### 3.1 Profile ontology (excerpt)

```yaml
ontology:
  nodes:
    - { kind: Class,      identity: [fqn] }
    - { kind: Method,     identity: [fqn, descriptor] }
    - { kind: Bean,       identity: [name] }
    - { kind: Entity,     identity: [fqn] }
    - { kind: Table,      identity: [schema, name] }
    - { kind: Endpoint,   identity: [httpMethod, pathTemplate] }
    - { kind: Queue,      identity: [name] }
    - { kind: BuildModule,identity: [coordinates] }
    - { kind: SharedState,identity: [fqn, field] }
  edges:
    - { kind: CALLS,        from: [Method], to: [Method], props: { dispatch: enum } }
    - { kind: INJECTS,      from: [Class],  to: [Bean] }
    - { kind: MAPS_TO,      from: [Entity], to: [Table] }
    - { kind: READS,        from: [Method], to: [Table, Queue, SharedState] }
    - { kind: WRITES,       from: [Method], to: [Table, Queue, SharedState] }
    - { kind: EXPOSES,      from: [Class],  to: [Endpoint] }
    - { kind: HTTP_CALLS,   from: [Method], to: [Endpoint] }   # internal self-calls!
    - { kind: TX_SPANS,     from: [Method], to: [Method] }
    - { kind: FK,           from: [Table],  to: [Table] }
    - { kind: DEPENDS_ON,   from: [BuildModule], to: [BuildModule] }
```

### 3.2 Parsers

| Parser | Input | Emits | Notes |
|---|---|---|---|
| `java-source` | `**/*.java` | `unit-defined` (Class), `member-defined` (Method/Field), `call-observed` (syntactic, receiver *type hint* only), `reference-observed` (imports, type uses), `annotation-observed` (`@Service`, `@Autowired`, `@Transactional`, `@Entity`, `@Table`, `@GetMapping`, JAX-RS…) | tree-sitter or JavaParser; tolerant — a file that half-parses still yields its parseable types |
| `jvm-bytecode` | `**/*.class`, jars | `call-observed` with exact descriptors and dispatch kind (`invokestatic`/`invokevirtual`/`invokeinterface`/`invokedynamic`), `unit-defined` with resolved hierarchy (super, interfaces) | ASM. The precision anchor: source facts carry spans for humans, bytecode facts carry truth for the call graph |
| `build-files` | `pom.xml`, `build.gradle*` | `unit-defined` (BuildModule), `reference-observed` (declared deps), `binding-observed` (plugin config) | existing module boundaries are evidence, not truth — they're often exactly what's wrong |
| `spring-config` | `applicationContext*.xml`, `application*.{properties,yaml}` | `binding-observed` (bean defs, property values, profiles), `reference-observed` (bean refs) | |
| `persistence-config` | `persistence.xml`, `orm.xml`, Liquibase/Flyway changelogs | `binding-observed`, `layout-defined` | |
| `sql-ddl` | schema dumps, migration SQL | `layout-defined` (Table + columns), `reference-observed` (FKs), `data-access-observed` (for DML in migrations) | |
| `sql-in-code` | (re-invoked on string constants extracted by `java-source`) | `data-access-observed` with table names, lower parse fidelity | regex/miniparser over JPQL/native SQL strings; confidence reflects it |
| `web-descriptors` | `web.xml`, `*.jsp` (refs only) | `binding-observed` (servlet mappings, filters) | |
| `mq-config` | broker/destination config | `unit-defined` (Queue), `binding-observed` | |

Example — one `java-source` output fragment for a service class:

```jsonc
{ "kind": "annotation-observed", "version": 1, "span": {"startLine": 18},
  "props": { "on": "com.acme.billing.InvoiceService", "onKind": "class",
             "annotation": "org.springframework.stereotype.Service" } }

{ "kind": "call-observed", "version": 1, "span": {"startLine": 88}, "confidence": 1.0,
  "props": { "caller": "com.acme.billing.InvoiceService#close(Ljava/lang/String;)V",
             "calleeName": "recalculate", "receiverTypeHint": "com.acme.tax.TaxEngine",
             "dispatch": "virtual" } }

{ "kind": "annotation-observed", "version": 1, "span": {"startLine": 84},
  "props": { "on": "com.acme.billing.InvoiceService#close…", "onKind": "method",
             "annotation": "org.springframework.transaction.annotation.Transactional",
             "args": { "propagation": "REQUIRED" } } }
```

### 3.3 Resolver passes

**Phase 10 — `java-identity` (builtin, configured).** Unify source FQNs with
bytecode class names; attach source spans to bytecode-derived nodes. Classify
generated code (protobuf, Lombok-expanded) via path/annotation rules so it
can be discounted later. Emit `alias` directives for inner-class name forms
(`Foo$Bar` vs `Foo.Bar`).

**Phase 20 — `call-resolution`.** The precision merge:

- where bytecode facts exist, they win: `invokestatic`/`invokespecial` →
  `CALLS` at confidence 1.0;
- `invokevirtual`/`invokeinterface` → Class-Hierarchy Analysis over the
  unified hierarchy. Single concrete implementor → one edge, 0.95. N
  implementors → N edges at graded confidence *plus* one
  `ambiguous-dispatch` claim if N exceeds a threshold;
- `invokedynamic`/reflection remain for phase 40;
- source-only call facts (no bytecode available) resolve by import + type
  hint at 0.7.

**Phase 20 — `spring-wiring`.** Bean space construction: `@Service`/`@Component`
annotations + XML bean defs → `Bean` nodes and `DEFINES_BEAN`; `@Autowired`/
`@Inject`/constructor injection + XML `ref=` → `INJECTS`, resolving by type
against the bean space, honoring `@Qualifier`/`@Primary`/profile activation
from `binding-observed` facts. Unresolvable multi-candidate injection → claim
(the example directive in §2.1). Property placeholders `${…}` resolve through
the merged property facts.

**Phase 30 — `jpa-mapping`.** `@Entity`/`@Table` + naming-strategy config →
`Entity ─MAPS_TO→ Table`; repository interfaces and `EntityManager` usage →
method-level `READS`/`WRITES` on tables; `sql-in-code` table names join here
at lower confidence; DDL FKs → `FK` edges. Result: **database coupling
becomes graph-visible** — two "unrelated" packages hammering the same table
is now an edge pattern, not a surprise during the split.

**Phase 30 — `transaction-boundaries`.** `@Transactional` propagation
analysis over the resolved call graph → `TX_SPANS` edges marking call chains
that must not be severed by a module boundary (or must become sagas —
either way, the planner needs to see them).

**Phase 30 — `endpoint-routing`.** MVC/JAX-RS annotations → `Endpoint` nodes +
`EXPOSES`; then the underrated one: `RestTemplate`/`WebClient`/Feign call
sites whose URL constants/templates match *own* endpoints → `HTTP_CALLS`
edges. A monolith calling itself over HTTP is a pre-existing seam worth
surfacing.

**Phase 40 — `reflection-and-dynamic`.** `Class.forName`/`loadClass` with a
string constant → resolved edge at 0.8; with a computed expression → claim
carrying the expression text and any candidate set derivable from string
facts (e.g. a strategy registry's property file). JNDI lookups similarly.

**Phase 40 — `shared-state`.** Static mutable fields, `ThreadLocal`s,
in-process caches, singletons-with-state → `SharedState` nodes with
`READS`/`WRITES` from accessing methods. For boundary derivation these get
the strangler-fig "shared mutable state" heavy weight.

**Phase 50 — `runtime-corroboration` (optional).** APM traces / access logs
parsed as ordinary artifacts corroborate `CALLS`/`HTTP_CALLS`/table access:
runtime-observed edges gain a high-confidence evidence record; statically
asserted but never-observed edges keep static evidence only (input for
dead-code claims, not deletion).

### 3.4 What the graph yields downstream

The decomposition-relevant projection inputs are now all present as typed
edges: `CALLS` (weight: moderate, hub-discounted), `INJECTS` (moderate),
shared-`Table` writes (heavy), `SharedState` (heaviest), `TX_SPANS`
(near-inviolable — clustering constraint, not just weight), `FK` (schema
split cost), `HTTP_CALLS` (negative weight — an existing seam). Boundary
candidates then carry per-membership reasons like *"in unit `billing`
because: 14 CALLS within, WRITES to INVOICE/INVOICE_LINE shared only within,
1 TX_SPANS chain fully contained."*

---

## 4. Worked example B: mainframe → cloud migration

Goal differs from discovery-only strangler-fig: the graph must support
*re-platforming decisions* — what becomes a service, what becomes a workflow,
what each dataset becomes, what can be decommissioned. That pulls in more
operational artifacts (schedulers, catalogs, CICS definitions, runtime logs)
as first-class parse inputs.

### 4.1 Profile ontology (excerpt)

```yaml
ontology:
  nodes:
    - { kind: Program,     identity: [name],        props: { language: enum(cobol, asm, pl1, ezt) } }
    - { kind: Paragraph,   identity: [programName, name] }
    - { kind: Job,         identity: [name] }
    - { kind: Step,        identity: [jobName, name] }
    - { kind: Dataset,     identity: [normalizedName], props: { org: enum(vsam-ksds, vsam-esds, ps, gdg, db2, …) } }
    - { kind: Table,       identity: [schema, name] }        # DB2
    - { kind: Layout,      identity: [copybook, recordName] }
    - { kind: Transaction, identity: [tranId] }               # CICS
    - { kind: Map,         identity: [mapset, name] }         # BMS
    - { kind: ScheduleEntry, identity: [scheduler, jobName] }
  edges:
    - { kind: CALLS,       from: [Program], to: [Program], props: { callType: enum(static, dynamic) } }
    - { kind: LINKS, kind2: XCTL }                            # EXEC CICS LINK / XCTL as distinct kinds
    - { kind: EXECUTES,    from: [Step], to: [Program] }
    - { kind: ALLOCATES,   from: [Step], to: [Dataset], props: { ddName, disp } }
    - { kind: READS/WRITES/UPDATES, from: [Program], to: [Dataset, Table] }
    - { kind: USES_LAYOUT, from: [Program, Dataset], to: [Layout] }
    - { kind: STARTS,      from: [Transaction], to: [Program] }
    - { kind: SENDS_MAP,   from: [Program], to: [Map] }
    - { kind: PRECEDES,    from: [Job], to: [Job] }           # batch scheduling order
    - { kind: TRIGGERS,    from: [Job, Program], to: [Transaction, Job] }
```

### 4.2 Parsers

| Parser | Input | Emits | Notes |
|---|---|---|---|
| `cobol` | `**/*.cbl`, copybooks | `unit-defined`, `member-defined` (paragraphs), `call-observed` (static + dynamic w/ expression), `data-access-observed` (ordered file ops, `EXEC SQL` table access), `include-observed` (COPY, incl. under FD), `layout-defined` (levels, PIC, REDEFINES, OCCURS, offsets), `execution-observed` (EXEC CICS LINK/XCTL/START) | strangler-fig's tolerant island parser, near-verbatim: divisions/sections as anchors, unknown dialect syntax skipped as "water"; indeterminate layout offsets stay honest-unknown |
| `zos-jcl` | JCL, PROCs | `execution-observed` (EXEC PGM/PROC with substituted symbolics), `binding-observed` (DD cards: ddName → dataset, DISP, concatenation order), `unit-defined` (Job, Step) | catalogued-procedure expansion; instream data suppressed |
| `unikix-jcl` | rehosted shell jobs | same vocabulary | path-with-variables normalization |
| `bms` | mapsets | `layout-defined` (maps, fields, attributes), candidate screen titles | HLASM column/continuation rules |
| `db2-ddl` | DDL extracts | `layout-defined` (Table), `reference-observed` (FK, view→table) | |
| `cics-csd` | CSD extract (`DFHCSDUP` output) | `binding-observed` (tranId → program, program defs, TDQ/TSQ defs) | operational config as parse input |
| `scheduler` | CA-7 / Control-M / OPC exports | `execution-observed` (ScheduleEntry → Job), `reference-observed` (predecessor/successor, calendars, conditions) | the batch DAG lives here, not in JCL |
| `catalog` | IDCAMS `LISTCAT` output | `unit-defined` (Dataset with org/keys/sizes), `binding-observed` (GDG base → generations) | physical truth about data |
| `asm-stub` | assembler members | `unit-defined` (entry points only), `call-observed` where recognizable | deliberately shallow: enough to know an ASM program exists and is called; flag as `language: asm` for migration cost |
| `smf-logs` | SMF/CICS statistics extracts (optional) | `execution-observed` with counts and timestamps | runtime corroboration feed |

Example — `cobol` dynamic call and file-control facts:

```jsonc
{ "kind": "call-observed", "version": 1, "span": {"startLine": 2140}, "confidence": 1.0,
  "props": { "caller": "ACCT01", "calleeExpression": "WS-NEXT-PGM",
             "dispatch": "dynamic",
             "assignmentsObserved": ["MOVE 'ACCT9' TO WS-NEXT-PGM-PFX"] } }

{ "kind": "binding-observed", "version": 1, "span": {"startLine": 214},
  "props": { "bindingKind": "file-control", "selectName": "INVFILE",
             "assignTarget": "INVDD", "organization": "indexed", "recordKey": "INV-KEY" } }
```

Example — `zos-jcl` allocation facts for the matching step:

```jsonc
{ "kind": "execution-observed", "version": 1, "span": {"startLine": 12},
  "props": { "job": "DAILYINV", "step": "STEP030", "executes": "ACCT01" } }
{ "kind": "binding-observed", "version": 1, "span": {"startLine": 14},
  "props": { "bindingKind": "dd", "job": "DAILYINV", "step": "STEP030",
             "ddName": "INVDD", "dataset": "PROD.INVOICE.MASTER", "disp": "SHR" } }
```

### 4.3 Resolver passes

**Phase 10 — `mainframe-identity` (builtin, configured).** Unify `PGM=ACCT01`
with `PROGRAM-ID. ACCT01` (alias directives); normalize dataset names —
GDG generations collapse to the base, symbolic-substituted names normalize to
patterns; classify copybook/program duplicates across source libraries as
canonical/mirror/historical by path precedence + normalized hash.

**Phase 20 — `dd-resolution`.** The signature join (strangler-fig's core
move): COBOL `SELECT … ASSIGN TO INVDD` ⋈ JCL `STEP030 EXEC PGM=ACCT01` +
`//INVDD DD DSN=PROD.INVOICE.MASTER` → `Program:ACCT01 ─READS→
Dataset:PROD.INVOICE.MASTER`, evidence citing *both* files and spans. The
same program executed from other steps with different DD targets yields
multiple edges — that multiplicity is real (same code, different data
contexts) and must not be merged away, which is why the profile declares
`READS` with `identity: [executionContext]` (see §2.1).

**Phase 20 — `copybook-layout`.** `include-observed` under an FD ⋈
`layout-defined` from the copybook → `Dataset ─USES_LAYOUT→ Layout`; `WRITE
record-name` resolves through the FD to the physical dataset. Unresolved
copybooks (not in corpus) become claims — usually the tell that a source
library is missing from the extract.

**Phase 30 — `cics-routing`.** CSD tranId→program bindings → `Transaction
─STARTS→ Program`; `EXEC CICS LINK/XCTL` facts → `LINKS`/`XCTL` edges;
`SEND MAP` → `SENDS_MAP`; `EXEC CICS START TRANSID` → `TRIGGERS`. The online
call graph is now separated by mechanism — LINK (stays in-process
post-migration) vs XCTL (control transfer) vs START (async) — which is
exactly the distinction a cloud target design needs.

**Phase 30 — `db2-binding`.** `EXEC SQL` table access facts ⋈ DDL →
`Program ─READS/WRITES→ Table`; view references flattened to base tables with
the view kept as evidence.

**Phase 40 — `dynamic-call-resolution` (project-specific, the money
resolver).** Every estate has conventions; this resolver encodes them:

- constant-propagation over observed `MOVE` chains within the program →
  resolved `CALLS` at 0.8;
- naming-convention rules from the profile (e.g. *"WS-NEXT-PGM is always
  `ACCT9*` — the menu router table"*) → candidate edges at 0.6;
- call-table copybooks (program name arrays) parsed as candidates;
- still-unresolved → `dynamic-call-unresolved` claim with the expression and
  observed assignments. Answered claims come back as decision files (§2.1)
  and become edges on the next resolve run — the graph *converges* as SMEs
  answer questions, without anyone hand-editing the database.

**Phase 40 — `batch-precedence`.** Scheduler facts → `Job ─PRECEDES→ Job`
edges with condition metadata. This is what turns "500 jobs" into "11 batch
streams," and later, into cloud workflow candidates (Step Functions /
Airflow DAGs) — each stream is a projection over `PRECEDES` + shared-dataset
handoffs (`Step WRITES D` then later `Step READS D` = a data handoff edge the
target design must preserve or re-plumb).

**Phase 50 — `runtime-corroboration`.** SMF/CICS statistics raise confidence
on executed paths and, critically for decommission: `unit-defined` programs
with **zero** runtime executions over the observation window get a
`dormant-candidate` claim. Dead code is never deleted from the graph — it's
flagged, because "unused for 13 months" and "unused" differ by one year-end
job.

### 4.4 What the graph yields downstream

Cloud-target decisions become projection queries rather than spreadsheet
archaeology:

- **Service candidates**: transaction-rooted online subgraphs
  (`Transaction → STARTS/LINKS/XCTL closure`) clustered with shared-mutable
  VSAM/DB2 weighting — the mainframe analog of the Java shared-table rule.
- **Workflow candidates**: batch streams from `PRECEDES` + dataset-handoff
  chains; each stream's dataset touchpoints enumerate its data-migration
  scope.
- **Data disposition**: every `Dataset` node carries org/keys/layout +
  its full reader/writer set — the input for VSAM→(DynamoDB | Aurora |
  S3+Parquet) decisions, made per-dataset with evidence attached.
- **Decommission tracking**: programs/datasets whose live inbound edges have
  all been superseded by migrated equivalents, corroborated by runtime facts.
- **Risk/effort**: `language: asm` nodes, unresolved claims, and
  honest-unknown layouts are exactly where estimates should widen.

---

## 5. Build scope

What has to be built, and what already exists to draw from:

**Engine (generic, build once):**

1. Fact store + envelope validation + parser registry/executor — port from
   strangler-fig's `parse/facts.ts` + `registry.ts`, generalized to
   profile-declared kinds and persistent facts.
2. Resolver runner: phase ordering, fact/graph-slice materialization,
   directive ingestion (upsert/alias/claim), determinism checks.
3. Builtin resolvers: name unification, include resolution, duplicate
   lineage, decision-file application.
4. Claim + decision-file lifecycle.

**Java profile (new):** `java-source`, `jvm-bytecode`, `build-files`,
`spring-config`, `persistence-config`, `sql-ddl`/`sql-in-code` parsers;
`call-resolution`, `spring-wiring`, `jpa-mapping`, `transaction-boundaries`,
`endpoint-routing`, `reflection-and-dynamic`, `shared-state` resolvers.
Tree-sitter and ASM carry most of the parsing weight; the resolvers are where
the real work is.

**Mainframe profile (mostly ports):** `cobol`, `zos-jcl`, `unikix-jcl`, `bms`
parsers and `dd-resolution`, `copybook-layout` resolvers port from
strangler-fig nearly intact (reshaped to the directive contract). New:
`cics-csd`, `scheduler`, `catalog`, `asm-stub`, `smf-logs` parsers;
`cics-routing`, `dynamic-call-resolution`, `batch-precedence`,
`runtime-corroboration` resolvers.

The thin-slice milestone for each profile: **one artifact pair through the
full pipe** — for Java, one `@Service` class + its table landing as
`Class ─(via Method)─ WRITES→ Table`; for mainframe, the ACCT01/DAILYINV
example above landing as `Program ─READS→ Dataset` with two-file evidence —
then widen parser coverage behind a stable contract.
