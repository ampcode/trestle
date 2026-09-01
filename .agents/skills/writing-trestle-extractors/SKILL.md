---
name: writing-trestle-extractors
description: Writes Trestle extraction pipelines that transcribe source artifacts, AST/parser output, compiler diagnostics, and SCIP or other indexes into declared facts. Use when creating or editing extract/pipeline.ts or wiring an external tool into trestle extract.
---

# Writing Trestle extractors

Extraction is transcription: read an artifact, write down what it says as
facts, one observation per fact. You make exactly two semantic decisions —
everything else is plumbing the engine already handles (incrementality,
caching, retirement, validation):

1. **Which artifacts carry the observations your fact kinds name?**
   (COBOL sources, servicedef XML, a SCIP index, javac output, JCL…)
2. **What is the cheapest tool that reads each artifact reliably?**
   Regex for line-oriented formats, an XML/AST parser for structure, an
   existing index when someone already did the analysis.

The hard boundary: **the pipeline never infers.** If a fact would require
correlating two artifacts, emit both halves as separate facts and let a
resolver join them. Never dedupe, resolve names, or "fix up" — contradictory
observations are signal, not noise.

## Picking the adapter per artifact type

- **Line/keyword formats** (JCL, COBOL statements, properties): regex over
  `corpus.read(path)`, one cell per file.
- **Structured definitions** (Spring XML, servicedef, entitymodel, build
  files): parse in the file's cell; one fact per definition or reference,
  verbatim — unexpanded variables stay unexpanded.
- **ASTs / single-file parsers** (tree-sitter, javac AST dumps): `run` the
  tool per file inside that file's cell; walk the tree; one fact per
  construct; tool coordinates go in `locator`.
- **Compiler / build output** (javac diagnostics, Gradle dependency
  reports): one cell per invocation, the compiled fileset as `inputs`;
  parse the report; set `authority: { tool, version }`.
- **SCIP / foreign indexes**: someone else's finished analysis — transcribe
  it, never re-derive it. `acquire` the index (or `run` the indexer), decode
  symbols/occurrences into facts like `symbol-defined` / `symbol-referenced`
  with `authority` naming the indexer. Turning those into edges is still
  resolver work.

Lower `confidence` (< 1.0) for heuristic or LLM-backed extractors; the graph
keeps it per evidence row.

## Mechanics (copy this shape)

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

- `corpus.list/read/readBytes` — the only way to touch source; roots from
  `trestle.config.ts` (`corpusRoots`, default `corpora/` — one pinned
  submodule per estate, read-only). Reads are recorded into the cell
  fingerprint automatically.
- `memo(name, inputs, fn)` — the incremental cell. Unchanged inputs (and
  unchanged pipeline code) skip the body; changed cells retire and replace
  their previous facts; a cell that disappears from the run has its facts
  retired. Cell names must be stable (derive from path/tool, never a
  counter). One cell per file, or per tool invocation.
- `run(tool, args)` → `{ stdout, stderr, status }`; command+args join the
  fingerprint. `acquire(name, fetch)` freezes a remote input once under
  `.state/artifacts/` — the only place network is allowed.
- `emit({ kind, sourcePath, locator?, confidence?, authority?, props })` —
  schema-checked; undeclared kind or prop is an error (extend the profile
  first).

Facts persist across runs: iterate on resolvers without re-extracting.
`trestle extract` re-runs only what changed.
