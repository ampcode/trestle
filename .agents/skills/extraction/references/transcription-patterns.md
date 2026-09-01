# Transcription patterns per artifact type

Pick the pattern matching the artifact; mixing patterns across artifact
types (regex for one, AST for another) is normal. In every pattern: one
observation per fact, verbatim values, `locator` pointing at where in the
artifact the observation sits.

## Line/keyword formats (JCL, COBOL statements, properties)

Regex over `corpus.read(path)`, one cell per file. Keep the regex anchored
to the format's real grammar (column positions for fixed-format COBOL/JCL).
Emit the matched text as-is — unexpanded variables stay unexpanded.

## Structured definitions (Spring XML, servicedef, entitymodel, build files)

Parse in the file's cell with a real parser (saxes for streaming XML); one
fact per definition or reference. These files are usually the semantic
backbone of an enterprise corpus — model their vocabulary richly in the
profile (a `service-defined` fact with engine/invoke/defaultEntity props
beats three generic ones).

## ASTs / single-file parsers (tree-sitter, javac dumps, prism, php-parse)

`run` the tool per file inside that file's cell; walk the tree; one fact
per construct. Tool coordinates (node offsets, line/col) go in `locator`.
Constant-fold only what the parser itself resolves (string concat of
literals); anything dynamic becomes its own fact kind (e.g.
`dynamic-service-call-observed` with the unevaluated expression) so a
resolver can raise a claim instead of the pipeline guessing.

## Compiler / build output (javac diagnostics, Gradle reports, Roslyn)

One cell per invocation, the compiled fileset as `inputs`; parse the
report; set `authority: { tool, version }`. If compilation of part of the
corpus is impractical (memory, broken tests), narrow the invocation and
cover the remainder with a syntax-tier tool in separate cells — coverage
gaps are visible in survey rather than silently absent.

## SCIP / foreign indexes

Someone else's finished analysis — transcribe it, never re-derive it.
`acquire` the index (or `run` the indexer as its own cell), decode
symbols/occurrences into facts like `symbol-defined` /
`symbol-referenced`, `authority` naming the indexer and version. Turning
occurrences into edges (and deciding which symbols are graph-worthy) is
resolver work, not pipeline work.

## Confidence

`confidence: 1` for facts a deterministic tool asserted. Lower it for
heuristic tiers: regex scans over free-form code, ctags symbol maps,
LLM-backed extraction. The graph keeps confidence per evidence row, so
resolvers and queries can weigh mechanisms differently (e.g. OFBiz weighted
import-based references at 0.3 against compiler-resolved references at 1.0).
