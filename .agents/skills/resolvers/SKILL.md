---
name: resolvers
description: Writes Trestle resolvers that turn extracted facts into graph nodes, edges, aliases, and claims with evidence. Use when creating or editing resolvers/*.ts, mapping facts to entities, joining facts across files, or handling unresolved references.
---

# Writing Trestle resolvers

A resolver answers **one semantic question** about the estate and writes the
answer into the graph. Name the resolver after its question: "which node
does each definition fact declare?" (`unit-mapping`), "which dataset does
each DD binding reach?" (`dd-resolution`), "which component owns each
class?" (`component-ownership`). One question per resolver — the engine
runs them in `phase` order and handles retirement, so each run must produce
the resolver's entire answer; partial output is a bug. Current node/edge
upserts enrich existing properties: omitting a property does not retract
it. Do not assume resolving is a fresh projection of the facts.

The hard boundary: **resolvers never read artifacts.** Missing information
means a pipeline gap — add a fact kind, don't work around it here.

Pick the pattern that matches your question:

- **The fact already contains the conclusion** (definition facts → nodes,
  literal call facts → edges): `mapFacts` — a mechanical rewrite table.
  This is the most common resolver by far.
- **The answer requires correlating facts** (binding halves, name → impl,
  entity → table): build a `slice.index` on one side, loop the other,
  emit edges citing **both** facts as evidence.
- **Two names denote one entity** (bare name vs. qualified, alias tables):
  `emit.alias(canonical, alias)` — edges and evidence re-point automatically.
- **You cannot answer honestly** (dynamic dispatch, unresolved reference,
  ambiguous match): `emit.claim(...)` with the candidates you considered.
  Claims are the honest alternative to guessing; the survey ranks them.
- **Deliberately out of scope**: `emit.ignore(subject, reason)`.

Every unmatched item must become an edge, an alias, a claim, or an ignore —
silence is not an option. Auto-vivified **stub** endpoints (edges pointing
at nodes nobody declared) are normal: they are the survey's unresolved
population, which a later resolver, alias, or pipeline fix explains.

There is no confidence score. A rule either justifies an edge or it does
not; if a match is too weak to stand as an edge (a naming convention, a
partial string), emit a claim instead and tighten the rule or the profile
until it is. Tag every directive with `rule:` so the survey and reviewers
can trace conclusions.

## Mechanics (copy these shapes)

Mechanical rewrite (`mapFacts`):

```ts
// resolvers/unit-mapping.ts
import { resolver, mapFacts } from "trestle";

export default resolver({
  name: "unit-mapping", phase: 10,
  consumes: { facts: ["service-defined"] },
  run(slice, emit) {
    mapFacts(slice, emit, {
      "service-defined": [
        { node: (f) => ({ kind: "Service",
            // SAFETY: this fact kind declares name as required t.string(), validated at insertion.
            identity: { name: f.props.name as string } }),
          rule: "service-node" },
        // edge rows: { edge, from(f), to(f), identity?(f), rule, props?(f) }
      ],
    });
  },
});
```

Correlation join:

```ts
export default resolver({
  name: "dd-resolution", phase: 20,
  consumes: { facts: ["binding-observed"] },
  run(slice, emit) {
    // SAFETY: the profile requires string ddName on the DD facts selected by this branch.
    const dd = slice.index("binding-observed",
      (f) => f.props.bindingKind === "dd" ? [f.props.ddName as string] : null);
    for (const fc of slice.facts("binding-observed").where((f) => f.props.bindingKind === "file-control")) {
      // SAFETY: the profile requires string assignTarget on these file-control facts.
      const matches = dd.get([fc.props.assignTarget as string]);
      if (matches.length === 0) {
        emit.claim("dd-unbound", { about: [fc.props.assignTarget],
          detail: `no DD card binds ${fc.props.assignTarget}`, rule: "dd-join" });
        continue;
      }
      for (const m of matches) {
        emit.edge("READS",
          { from: `Program:${fc.props.program}`, to: `Dataset:${m.props.dataset}`,
            identity: { executionContext: `${m.props.job}.${m.props.step}` } },
          { evidence: [fc, m], rule: "open-input" });
      }
    }
  },
});
```

- `emit.node(kind, identity, props?, { evidence?, rule })` — positional:
  identity object first, then props. Cite the defining fact as evidence;
  `trestle doctor` flags declared nodes with none.
- `emit.edge(kind, { from, to, identity? }, { evidence, rule, props? })`
  — evidence is required; node refs are `"Kind:value"` (single-field
  identity) or `{ kind, identity: {...} }`.
- `slice.facts(kind)` requires the kind in `consumes.facts`;
  `slice.nodes(kind?)`/`slice.edges(kind?)` read earlier phases' graph
  (entity mapping ≈ phase 10, joins ≈ 20, aggregation ≈ 30+).
- `slice.evidenceFor(stableId)` returns the live evidence rows behind a
  prior-phase node or edge. A derived edge (e.g. SHARES_MUTABLE_X computed
  from co-writer edges) should pass those rows straight into its own
  `evidence` so it cites the original facts instead of inventing a weaker
  locator.
- Per-rule branching: `rules("set", [{ name, when, ... }])`
  then `.require(x)` / `.apply(x)`.
- Fact and entity props use `Properties` (`JsonValue` values), not a
  fact-kind-specific generated type. Use inference for emitted props.
  When narrowing a fact prop to an identity or index key, justify a cast
  with the actual profile schema, as above; if that schema does not
  guarantee the value, validate it instead. Run `npm run lint` alongside
  typechecking so copied resolver examples stay compatible with anti-slop.
