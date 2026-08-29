---
name: running-the-trestle-loop
description: Runs and interprets the Trestle extract → resolve → survey loop on a migration project. Use when deciding what to work on next, reading survey output, diagnosing stub nodes or open claims, or checking store status.
---

# Running the Trestle loop

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
It requires the optional `@ladybugdb/core` package (`npm install
@ladybugdb/core` in your project). The projection database admits one
process at a time; a second `project query` waits up to 10s for the
lock, so run queries sequentially rather than fanning out in parallel.
Node kinds become node tables
(identity fields + scalar props as columns, `provenance` for stub
detection), edge kinds become rel tables with `confidence` and
`evidenceCount` from the live evidence rows.

Facts persist: iterating on resolvers needs only `resolve` + `survey`.
Re-run `extract` after corpus, pipeline, or profile changes. Everything is
safe to re-run; each stage retires and replaces its own prior output.

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
  artifact type (see writing-trestle-extractors).
- Vocabulary missing (a real-world concept has no kind) → edit profile.ts,
  `trestle profile build`, then extract/resolve.

Fix the earliest broken stage first: profile before pipeline before
resolver. A resolver workaround for a transcription gap hardens the gap.

## Where things live

`trestle/` in the host repo: `profile.ts` + `profile.lock.json` (committed),
`extract/pipeline.ts`, `resolvers/*.ts`, `trestle.config.ts`, and gitignored
`.state/` (SQLite store, frozen artifacts). Deleting `.state/` is safe —
everything regenerates from the corpus.
