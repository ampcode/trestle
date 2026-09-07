---
name: trestle-loop
description: Runs and interprets the Trestle extract → resolve → survey loop on a migration project. Use when deciding what to work on next, reading survey output, diagnosing stub nodes or open claims, or checking store status.
---

# Running the Trestle loop

Run commands from the project root and read `trestle.config.mts` (or legacy `trestle.config.ts`) first; customized projects may override the default `trestle/` graph paths. Use `npx trestle` when the CLI is installed locally rather than on PATH.

Trestle projects converge by iteration, and the survey decides each step:

```
trestle profile build   # only after editing profile.ts
trestle extract         # artifacts -> facts (incremental; memo-skips unchanged cells)
trestle resolve         # facts -> nodes/edges/evidence/claims (idempotent)
trestle survey          # the unresolved population, ranked
trestle status          # revision + live row counts
trestle project build   # materialize the Cypher projection (LadybugDB)
trestle project query 'MATCH ...'   # query it
```

The projection is derived and disposable — rebuild it after any resolve.
Node kinds become node tables, edge kinds become rel tables with an
`evidenceCount` column; both expose `stableId` for evidence retrieval.
Read-only queries may run concurrently. Builds exclude other builders and
publish immutable generations while existing readers keep their snapshot.
See `node_modules/trestle/README.md`, "Projection consistency and upgrades", for cleanup and recovery.

For supporting source locations, use `graph_evidence` with the query's
`stableId` and `entityType: "node"` or `"edge"`. Page with `nextAfterId`
and the first page's `generation` as `expectedGeneration`; restart from
the first page on mismatch. Run `revision` is provenance, not a mutation
token. Query metadata's `sourceGeneration` identifies the projection's
source snapshot; compare it with evidence `generation` to detect staleness.

Facts persist: iterating on resolvers needs only `resolve` + `survey`.
Re-run `extract` after corpus, pipeline, or profile changes. Everything is
safe to re-run; each stage retires and replaces its own prior output.
Renamed or deleted resolver files are handled: the next `resolve` retires
the missing owner's prior output before the pass runs.

Idempotency signals: a clean re-extract prints `0 cells computed, N
skipped`; a clean re-resolve ends with `live graph unchanged`. Per-resolver
directive counts always show churn (each resolver retires and reapplies its
own provenance) — read the live-graph delta line, not the directive counts.

## Reading the survey

The survey is a to-do list, not a report card. It shows:

- **facts (live) by kind** — near-zero counts for a kind you expected means
  a pipeline gap; huge counts with no consuming resolver means unused signal.
- **nodes by kind × provenance** — `declared` nodes were asserted by a
  resolver; `stub` nodes were auto-vivified as edge endpoints nobody has
  explained yet. Stubs *are* the unresolved population.
- **top stubs by edge count** — the highest-leverage next step. 2,300 edges
  pointing at one stub means one resolver rule (or one alias) will explain
  2,300 edges at once.
- **open claims by kind** — questions resolvers recorded instead of
  guessing. Each claim kind usually wants either a new rule, a pipeline fix
  upstream, or a human decision noted in the project docs.

## Choosing the next step

- Stub with many edges → write/extend the resolver that should declare it,
  or `alias` it onto an existing node (naming mismatch). Stubs may also be
  deliberately retained as known-but-undeclared identities (e.g. nested
  classes referenced from imports) — note that decision in project docs
  rather than forcing a declaration.
- Claim cluster of one kind → add the join rule or fact kind it is waiting
  on.
- Expected fact kind missing → pipeline gap: add transcription for that
  artifact type (see the extraction skill).
- Vocabulary missing (a real-world concept has no kind) → edit profile.ts,
  `trestle profile build`, then extract/resolve.

Fix the earliest broken stage first: profile before pipeline before
resolver. A resolver workaround for a transcription gap hardens the gap.

## State

The configured state directory defaults to `trestle/.state/` in new projects.
It contains the SQLite store, frozen acquired artifacts, and projection.
Do not delete it to fix extraction: history, coordination records, and frozen
inputs may not be reproducible. The projection alone is disposable.
New projects analyze the current repository. Configure additional `corpusRoots`
for other estates; `trestle corpus add` writes into the first root.
