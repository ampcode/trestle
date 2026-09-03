# Kernel Regression Scenarios

The simplicity test from [architecture.md](./architecture.md): a new use case
must be expressible as **pure data (profile) + executables (parsers,
resolvers)**. The day one needs an `if` in engine code, either it revealed a
genuinely missing mechanic (rare — add deliberately) or someone is smuggling
vocabulary into the kernel (usual — push back to profile).

This document runs that test against twelve scenarios. Verdicts:

- ✅ **holds** — pure profile + executables, no kernel change
- ⚠️ **holds with discipline** — expressible, but only if a stated convention
  is followed; the convention is recorded here
- ❌ **kernel change** — the scenario exposes a missing or wrong mechanic;
  amendment specified and applied to the specs

| # | Scenario | Verdict |
|---|---|---|
| 1 | Rails app modularization | ✅ |
| 2 | ETL estate (Informatica → dbt/Airflow) | ✅ (scale caveat) |
| 3 | Oracle→Postgres with PL/SQL and triggers | ✅ |
| 4 | Frontend monorepo split with codegen | ✅ |
| 5 | C/C++ estate (preprocessor) | ❌ parse-unit closure |
| 6 | Binary-only / runtime-only estate | ❌ evidence locator |
| 7 | Same edge, different contexts | ❌ edge identity tuples |
| 8 | Post-acquisition system merge (two corpora) | ⚠️ alias vs. equivalence |
| 9 | SME knowledge with no source artifact | ✅ (pleasant surprise) |
| 10 | PII/data-flow compliance mapping | ✅ |
| 11 | "What did the graph say last quarter?" | ⚠️ resist time-travel |
| 12 | Live codebase changing mid-migration | ⚠️ known open question |

Three kernel amendments came out of this exercise (#5, #6, #7). All three
make the kernel *more* uniform, not bigger — which is roughly the signature
of a correct amendment.

---

## 1. Rails app modularization ✅

The fear: Ruby is dynamic, and Rails is convention-over-configuration —
`has_many :orders` implies a class, a table, an FK, and a dozen generated
methods, none of them literally in the file.

The test run: the parser stays dumb and single-file — it emits
`annotation-observed`-style facts for macros (`has_many`, `belongs_to`,
`validates`) exactly as written. All inference is resolver work:
a phase-30 `activerecord-conventions` resolver derives
`Class ─ASSOCIATES→ Class` and `Class ─MAPS_TO→ Table` edges by applying
naming conventions (pluralization, FK inference) — the same slot the
mainframe profile uses for naming-convention dynamic-call resolution.
`method_missing` metaprogramming → claims, same as reflection in Java.

Convention-heavy frameworks actually *favor* this kernel: conventions are
precisely "knowledge requiring no second file but not literally observable,"
which is the resolver's job description. **No kernel change.**

## 2. ETL estate ✅ (scale caveat)

Informatica/DataStage workflow XML exports, SQL scripts, Airflow DAGs.
Everything is artifact-shaped (XML exports parse like CSD extracts).
The new wrinkle is **column-level lineage**: `Column` nodes with identity
`[schema, table, name]` and `DERIVES_FROM` edges per transformation
expression. Shape-wise this is pure profile.

The caveat is cardinality, not vocabulary: a serious estate has 10⁶–10⁷
columns and more derivation edges. That stresses storage and resolver-slice
materialization (engineering: chunked slices, cursor APIs, Postgres backend)
but requires no new concept. **No kernel change; scale is an implementation
concern, flagged.**

## 3. Oracle→Postgres, PL/SQL and triggers ✅

Triggers are execution caused by *data events*, not call sites. Tempting to
ask for an "event" mechanic. Unnecessary: `Trigger` is a node kind,
`FIRES_ON` an edge kind from `Trigger` to `Table` with `props: { on: update }`,
and `EXECUTES` from `Trigger` to `Procedure`. A phase-30 resolver closes the
loop: any `WRITES → Table` implies reachable trigger execution — derivable,
so it's a projection query or a derived edge with evidence, per profile
choice. Scheduler jobs (DBMS_SCHEDULER) parse like CA-7 exports. **No kernel
change.**

## 4. Frontend monorepo split with codegen ✅

Generated artifacts (GraphQL codegen, protobuf stubs) initially look like
they need artifact→artifact derivation mechanics. They don't: generated
files are ordinary artifacts; a `codegen-config` parser emits facts from
generator configs; a resolver adds `File ─GENERATED_FROM→ File` edges and a
`generated: true` classification that the weight model discounts (same
mechanism the Java profile uses for Lombok). Incremental ingest already keys
on artifact hash, so regeneration is just a changed artifact. **No kernel
change.**

## 5. C/C++ estate ❌ → parse-unit closure

**The failure.** The parser contract said: one artifact, no sibling-file
access. C/C++ breaks this hard — you cannot even *lex* a translation unit
correctly without the preprocessor, and the preprocessor needs headers.
COBOL got away with single-file parsing because island parsing tolerates
unresolved COPY; macros are not tolerable that way (they change token
boundaries).

Wrong fixes: let parsers scan the filesystem (destroys determinism and
incremental-ingest keying); make a C-specific exception (vocabulary in the
kernel).

**Amendment — parse units.** A profile rule may declare a *closure rule*: the
registry (not the parser) assembles a parse unit = primary artifact +
dependency closure (headers via include-path config), and the fact-store key
becomes the hash of the whole closure. The parser still receives explicit
inputs, still deterministic, still cache-keyed — the *registry* owns file
discovery, as it always did. Java annotation processing and TypeScript
project references benefit from the same mechanic. Single-artifact parsing
remains the default degenerate case (closure = 1).

Follow-up: where closure rules get include paths is answered by **extraction
rounds** (extract-resolve.md §1.4) — build metadata like `compile_commands.json`
is parsed in an earlier round, and closure rules consume its facts.

## 6. Binary-only / runtime-only estate ❌ → evidence locators

Estate with lost source: facts come from disassembly, network traces, APM
data. Artifact-shaped? Yes (binaries, trace exports). But the evidence
envelope said `span: { startLine, endLine }` — **line spans assume text**.
Disassembly wants byte offsets; traces want time windows; database-resident
logic wants row locators.

**Amendment — generalize span to locator.** Evidence carries one of:

```jsonc
{ "locator": { "type": "lines",  "startLine": 88, "endLine": 92 } }
{ "locator": { "type": "bytes",  "start": 18744, "end": 18892 } }
{ "locator": { "type": "record", "key": "SMF:2026-07-14:seq=88213" } }
{ "locator": { "type": "window", "from": "…", "to": "…", "count": 1422 } }
```

Line spans remain the common case. This also cleans up the mainframe
profile's SMF corroboration, which was already quietly abusing line spans.

## 7. Same edge, different contexts ❌ → edge identity tuples

**A contradiction we shipped in our own spec.** extract-resolve.md §2.1 said
edges upsert on `(kind, from, to)` accumulating evidence; §4.3 said ACCT01
reading different datasets from different JCL steps yields *multiple edges*
that "must not be merged." Both can't be true — with upsert-on-triple, two
`READS` from different steps to the *same* dataset silently merge, losing
that the accesses happen in different batch contexts (different DISP,
different data lifecycle). The Java profile hits the same wall:
`HTTP_CALLS` through two different endpoints' URL templates.

**Amendment — per-edge-kind identity tuples**, exactly mirroring node
identity:

```yaml
edges:
  - kind: READS
    from: [Program]
    to: [Dataset]
    identity: [executionContext]   # optional; default = (kind, from, to)
    props: { executionContext: string, ddName: string }
```

Edges with the same `(kind, from, to, identity-props)` merge and accumulate
evidence; different identity-prop values are distinct edges. The kernel gets
*more* uniform (nodes and edges now have the same identity mechanic), and
the default keeps simple profiles simple.

## 8. Post-acquisition merge of two systems ⚠️

Two corpora, overlapping business concepts: both estates have a "customer
master." The trap is reaching for `alias` — alias is **identity** (these
observations are the same artifact-backed thing) and merging two genuinely
distinct implementations would be destructive and wrong.

**Discipline rule, now recorded:** `alias` is reserved for observations of
the same concrete thing (name-form variants, PGM= vs PROGRAM-ID). Sameness
of *meaning* across distinct things is an ordinary edge —
`EQUIVALENT_TO` with evidence, produced by resolvers or
answered claims — which clustering and planning can consume without the
graph pretending two codebases are one. Corpus membership goes in node
props via a corpus-root context the registry already passes to parsers.
**Kernel holds; convention required.**

## 9. SME knowledge with no source artifact ✅

"Marge from ops says the ACCT9 router never routes to ACCT97 in production
anymore." No file says this. Does the every-fact-has-an-artifact rule break?

No — and this is the kernel paying rent: write it down as a Git-tracked
**decision file** (the same mechanism that answers claims), which *is* an
artifact, parsed by the decision-file parser into facts, becoming evidence
with provenance = that file, that commit, that author. Interview knowledge
enters the graph only by being committed to Git first — which is not a
limitation, it's an audit trail. Evidence and supersession work unchanged
(Marge can be wrong; a later runtime fact can contradict her; both evidence
records persist). **No kernel change, no exceptions needed.**

## 10. PII / data-flow compliance mapping ✅

`DataElement` nodes (SSN, PAN), `CONTAINS_PII` on layouts/columns,
`FLOWS_TO` edges derived by a taint-propagation resolver. The only question
was whether fixpoint iteration (taint propagates until stable) fits the
single-pass resolver contract — it does: a resolver is an arbitrary program;
it can iterate internally over its materialized slice and emit the closure.
Phases order *inter*-resolver dependencies, not *intra*-resolver algorithms.
**No kernel change.**

## 11. "What did the graph say last quarter?" ⚠️

Tempting mechanic: bitemporal storage, time-travel queries. **Resisted.**
GraphRevision + deterministic snapshots already answer the auditable
version of the question (diff two snapshots; evidence and projections pin
revisions). Full time-travel would roughly double storage-layer complexity
to serve a reporting need that snapshot diffing covers. If a future factory
truly needs it, it's an additive storage feature — not a model change — so
deferring is cheap. **Kernel holds by refusing the feature.**

## 12. Live codebase changing mid-migration ⚠️

The monolith team keeps shipping while units migrate. The kernel has the
right primitives — artifact-hash-keyed facts (only changed files re-parse),
revisions, freshness-pinned verification evidence — but the **invalidation
cascade** (changed artifact → dirty facts → dirty resolver outputs → dirty
projections → stale verification) is designed in outline only
(architecture.md §10). This scenario doesn't reveal a wrong mechanic; it
confirms invalidation is the highest-risk unbuilt part of the engine.
Parse-unit closures (#5) make it slightly harder (a changed header dirties
its closure's units) — the amendment accounts for this by keying on closure
hash. **Known open question; priority raised.**

---

## Scorecard and amendments

Nine of twelve scenarios pass as pure profile + executables; two pass with
recorded conventions; three found real kernel defects, each fixed by a small
amendment that made the kernel more uniform:

1. **Parse-unit closures** (registry-assembled, closure-hash-keyed) — fixes
   C/C++, helps Java annotation processing; single-file stays the default.
2. **Evidence locators** (lines | bytes | record | window) — fixes
   binary/runtime evidence; line spans stay the common case.
3. **Edge identity tuples** (optional, mirrors node identity) — fixes a
   latent contradiction between upsert semantics and context multiplicity.

All three are applied to [architecture.md](./architecture.md) and
[extract-resolve.md](./extract-resolve.md).
