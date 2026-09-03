---
name: extraction
description: Routes extraction work on a Trestle graph repo — surveying a corpus, selecting AST/compiler/parser tools per ecosystem, and writing extract/pipeline.ts cells that transcribe artifacts into facts. Use when creating or editing extract/pipeline.ts, choosing a parser or indexer for a corpus, or wiring an external tool into trestle extract.
---

# Extraction

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
- Every fact kind and prop must be declared in `profile.ts` first;
  `emit` is schema-checked and rejects undeclared vocabulary.
- Tool-backed facts carry `authority: { tool, version }`. There is no
  confidence score: emit what was observed, and let the resolver decide
  whether that mechanism is strong enough to make an edge or only a claim.
- Facts persist across runs: iterate on resolvers without re-extracting.
  `trestle extract` re-runs only changed cells.
