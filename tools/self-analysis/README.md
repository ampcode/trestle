# Trestle on Trestle

A separate graph project over this checkout's working tree. It does not change
the root seed profile, pipeline, corpus configuration, or state. TypeScript's
compiler API supplies named declarations and resolved identifier references;
Trestle stores those facts, joins them into evidence-backed edges, and reports
unreferenced declarations as review claims, not proven dead code.

Run from `tools/self-analysis`:

```sh
node ../../bin/trestle.js profile build
node ../../bin/trestle.js extract
node ../../bin/trestle.js resolve
node ../../bin/trestle.js survey
node ../../bin/trestle.js doctor
node ../../bin/trestle.js project build
node ../../bin/trestle.js project query 'MATCH (f:Function) WHERE NOT EXISTS { MATCH ()-[:REFERENCES]->(f) } RETURN f.key, f.stableId'
node ../../bin/trestle.js project query 'MATCH (a:Function)-[e:SIMILAR_BODY]->(b:Function) RETURN a.key, b.key, e.stableId'
```

Use `SAME_BODY` for exact body-token matches. `SIMILAR_BODY` ignores identifier
spelling (including property names), but preserves other token text; neither
relation proves behavioral equivalence. Both require at least 30 body tokens.
Evidence on each comparison cites both declarations with file/line locators and
the TypeScript version. Reference edges aggregate all observed references from
one file to one function. Imports/re-exports and references inside unused code
count too: this is not reachability analysis or a function-to-function call graph.

`serve` can expose this project through the same MCP interface as the root
project. Given a query result's `stableId`, `graph_evidence` with `entityType:
"node"` returns a function's declaration location; `entityType: "edge"` returns
the references or compared declarations backing a relationship.

## Findings

The integrated working-tree run produced 41 file nodes, 170 function/method nodes, 327
`REFERENCES` edges, and two `no-observed-reference` claims. `doctor` was clean.

- **`Store.openClaims`** (`src/store/store.ts`): no observed callers. A direct
  search of source/tests also found only its declaration. An internal removal
  candidate, not proof that nobody imports engine internals outside this repo.
- **`FactList.where`** (`src/resolve/api.ts`): no in-corpus callers, but exposed
  through `Slice.facts()` and documented in the resolver skill. Retain as public
  resolver convenience unless intentionally changing that API.
- **No whole-function clone pairs at the 30-token threshold.** This does not
  rule out partial or edited clones. Manual inspection found near-identical
  node/edge evidence INSERT blocks inside `Store.applyDirectives`, plus repeated
  live-count SQL helpers in `src/server/serve.ts` and `src/cli/main.ts`. Those
  are smaller-block refactoring candidates, not results from the clone graph.

No suspected dead or duplicate engine code was removed.

## Coverage and limits

- Sources: JS/TS/JSX/TSX under `src`, `tests`, `bin`, seed `extract`/`resolvers`,
  `.amp/plugins`, and root-level code. Bundled `src/viz/assets`, dependencies,
  declaration files, corpora, skills, and other tooling are not analyzed as
  declarations. Dependencies may be read by the compiler for type resolution.
- Function identities are file path plus top-level binding/function name or
  named-class method name. Nested functions, anonymous callbacks, object-literal
  methods, constructors, accessors, overload identities, and call-site ownership
  are not modeled separately. Changing a function's line does not change its ID.
- Static references can miss reflection, computed properties, framework wiring,
  external clients, and unresolved types. Compiler semantic diagnostics are not
  a liveness oracle; only syntax errors fail this exploratory extractor.
- Whole-program extraction is one memo cell, keyed by compiler version, selected
  sources, package/config inputs, and pipeline code. Installed dependencies must
  match the checkout; upgrades can affect resolution. The working tree is not a
  pinned external corpus. Generated state stays in this project's `.state/`.
- `tests/self-analysis.test.ts` checks exact and identifier-renamed clones,
  generic-method and dynamic-import references, an unused candidate, provenance,
  graph health, and incremental extraction/resolution.
