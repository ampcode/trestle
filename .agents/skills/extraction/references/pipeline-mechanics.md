# Pipeline mechanics: the memo/run/acquire/emit contract

```ts
// extract/pipeline.ts
import { pipeline } from "trestle";

export default pipeline(async ({ corpus, memo, run, acquire, emit }) => {
  for (const path of corpus.list(/servicedef\/services.*\.xml$/)) {
    await memo(`servicedef:${path}`, [path], () => {
      const text = corpus.read(path);
      for (const m of text.matchAll(/<service name="([^"]+)"/g)) {
        emit({ kind: "service-defined", sourcePath: path,
               locator: { offset: m.index }, props: { name: m[1] } });
      }
    });
  }
});
```

## The five primitives

- `corpus.list/read/readBytes` — the only way to touch source; roots come
  from `trestle.config.ts` (`corpusRoots`, default `corpora/` — one pinned
  submodule per estate, read-only). Reads are recorded into the cell
  fingerprint automatically.
- `memo(name, inputs, fn)` — the incremental cell. Unchanged inputs (and
  unchanged pipeline code) skip the body; a changed cell retires and
  replaces its previous facts; a cell that disappears from the run has its
  facts retired.
- `run(tool, args)` → `{ stdout, stderr, status }`; command + args join the
  cell fingerprint. Check `status` — distinguish tool failure from empty
  output, and fail the cell on parse errors rather than emitting nothing
  silently.
- `acquire(name, fetch)` — freezes a remote input once under
  `.state/artifacts/`; the only place network is allowed.
- `emit({ kind, sourcePath, locator?, confidence?, authority?, props })` —
  schema-checked; an undeclared kind or prop is an error (extend
  `profile.ts` first, then `trestle profile build`).

## Cell discipline

- **Stable names.** Derive cell names from path or tool
  (`servicedef:${path}`, `scip:main`), never from a counter or ordering —
  an unstable name churns retirement.
- **Granularity.** One cell per file for per-file parsers; one cell per
  invocation for whole-program tools (compilers, indexers), with the
  compiled fileset as `inputs`.
- **Version the tool in the fingerprint.** `run`'s command+args are
  fingerprinted; if a tool's behavior changes without its args changing
  (upgraded binary), put the version in the cell name or args so old cells
  invalidate.
- **No inference, no state between cells.** A cell reads its inputs and
  emits facts. Correlation across artifacts is resolver work.

## What persists

Facts outlive runs: you can iterate on resolvers without re-extracting.
`trestle extract` re-runs only cells whose inputs or pipeline code changed;
a clean re-run should report `0 cells computed, N skipped` — use that as an
idempotency check after any pipeline edit.
