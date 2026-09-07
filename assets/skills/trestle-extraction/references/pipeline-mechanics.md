# Pipeline mechanics: the memo/run/acquire/emit contract

```ts
// trestle/extract/pipeline.ts (unless the Trestle config overrides it)
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

- `corpus.list/read/readBytes` — tracked source access; roots come
  from `trestle.config.mts` or legacy `trestle.config.ts` (`corpusRoots`). New
  projects analyze `.`; the list honors Git ignores and configured exclusions.
  Explicit reads are not restricted by list filters. Reads are recorded into the cell
  fingerprint automatically. `read` defaults to UTF-8; pass
  `corpus.read(path, "latin1")` for pre-UTF-8 estates (90s C++, mainframe
  exports) where UTF-8 decoding would insert replacement characters.
- `memo(name, inputs, fn)` — the incremental cell. Every entry in `inputs`
  **must be a corpus path** (or an absolute path returned by `acquire`);
  a bare label like `"saxes@6"` fails the probe as a missing file. Version
  or tool identity belongs in the cell *name*. Unchanged inputs (and
  unchanged pipeline code) skip the body; a changed cell retires and
  replaces its previous facts; a cell that disappears from the run has its
  facts retired.
- `run(tool, args)` → `{ stdout, stderr, status }`. Command and args do
  **not** enter the cell fingerprint directly — the fingerprint seed hashes
  the configured extraction directory (normally `trestle/extract/`; pipeline code *and* helper tools/scripts)
  plus the profile, so editing the code that constructs a `run` call
  invalidates all cells. An upgraded external binary is invisible to the
  seed: put its version in the cell name. Check `status` — distinguish
  tool failure from empty output, and fail the cell on parse errors rather
  than emitting nothing silently.
- `acquire(name, fetch)` — freezes a remote input once under the configured
  state's `artifacts/` directory (`trestle/.state/artifacts/` by default);
  the only place network is allowed.
- `emit({ kind, sourcePath, locator?, authority?, props })` —
  schema-checked; an undeclared kind or prop is an error (extend the configured
  profile, normally `trestle/profile.ts`, then `trestle profile build`).

## Cell discipline

- **Stable names.** Derive cell names from path or tool
  (`servicedef:${path}`, `scip:main`), never from a counter or ordering —
  an unstable name churns retirement.
- **Granularity.** One cell per file for per-file parsers; one cell per
  invocation for whole-program tools (compilers, indexers), with the
  compiled fileset as `inputs`.
- **Version the tool in the cell name.** The fingerprint seed covers
  the configured extraction directory, but not external binaries; when a tool's
  behavior changes without a code change (upgraded compiler, indexer),
  bump the cell name (`javac17:${path}`) so old cells invalidate.
- **No inference, no state between cells.** A cell reads its inputs and
  emits facts. Correlation across artifacts is resolver work.

## What persists

Facts outlive runs: you can iterate on resolvers without re-extracting.
`trestle extract` re-runs only cells whose inputs or pipeline code changed;
a clean re-run should report `0 cells computed, N skipped` — use that as an
idempotency check after any pipeline edit.
