---
name: trestle-extraction
description: Routes extraction work on a Trestle project — surveying a corpus, selecting parsers, and writing trestle/extract/pipeline.ts cells. Use when editing extraction or wiring a tool into trestle extract.
---

# Extraction

Read root `trestle.config.mts` (or legacy `trestle.config.ts`) first. New projects use `trestle/extract/pipeline.ts`; customized configs may point elsewhere.
For new projects, use `npx --prefix trestle trestle` for CLI commands and `npm --prefix trestle run typecheck` for graph code. Install parser dependencies under `trestle/`, not in the application.

Extraction is transcription: read an artifact, write down what it says as
facts, one observation per fact. You make exactly two semantic decisions —
everything else is plumbing the engine already handles (incrementality,
caching, retirement, validation):

1. **Which artifacts carry the observations your fact kinds name?**
   (COBOL sources, servicedef XML, a SCIP index, javac output, JCL…)
2. **What is the cheapest tool that reads each artifact reliably?**

The hard boundary: **the pipeline never infers.** If a fact would require
correlating two artifacts, emit both halves as separate facts and let a
resolver join them. Never dedupe, resolve names, or "fix up" — contradictory
observations are signal, not noise.

## Where to go

Work through these in order for a new corpus; jump straight to the one you
need otherwise. Paths are relative to this skill directory.

| Task | Reference |
|---|---|
| New corpus: map its file-type breakdown, build systems, generated/vendored dirs | `references/corpus-survey.md` |
| Pick the parser/AST/compiler/indexer per artifact type (curated index + web-search protocol for uncovered ecosystems) | `references/tool-selection.md` |
| Write or edit pipeline cells: `memo`/`run`/`acquire`/`emit` contract, cell naming, fingerprints | `references/pipeline-mechanics.md` |
| Shape the transcription for a given artifact type (regex, XML, AST walk, compiler output, SCIP) | `references/transcription-patterns.md` |

## Ground rules that apply everywhere

- One observation per fact, verbatim — unexpanded variables stay unexpanded.
- Every fact kind and prop must be declared in the configured profile (`trestle/profile.ts` by default) first;
  `emit` is schema-checked and rejects undeclared vocabulary.
- Tool-backed facts carry `authority: { tool, version }`. There is no
  confidence score: emit what was observed, and let the resolver decide
  whether that mechanism is strong enough to make an edge or only a claim.
- Facts persist across runs: iterate on resolvers without re-extracting.
  `trestle extract` re-runs only changed cells.
