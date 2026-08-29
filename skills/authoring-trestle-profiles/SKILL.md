---
name: authoring-trestle-profiles
description: Declares a Trestle profile — the node, edge, and fact vocabulary for a migration knowledge graph. Use when creating or editing profile.ts, choosing identities, adding kinds, or running trestle profile build/check.
---

# Authoring Trestle profiles

The profile is where you decide what your migration is *about*. Everything
else — extraction, resolution, the graph — is mechanical once the vocabulary
is right. Work backwards from the migration question:

1. **State the goal as a graph query.** "Which services can move into one
   container together?" · "Which programs still touch this dataset?" ·
   "What breaks if we retire this job?"
2. **The entities that query names become node kinds.** Java modularization:
   `Component`, `Service`, `Entity`, `JavaClass`. Mainframe: `Program`,
   `Job`, `Dataset`. 3–6 kinds is a strong start; add more only when a
   query needs them.
3. **The relationships the query traverses become edge kinds.** `DEPENDS_ON`,
   `CALLS_SERVICE`, `USES_ENTITY`, `READS`/`WRITES`. Name them as the
   assertion you want to be able to defend with evidence.
4. **For each edge, list the raw observations that could justify it — those
   are your fact kinds.** A `READS` edge might come from a COBOL
   `SELECT/ASSIGN` plus a JCL `DD` card: two fact kinds
   (`binding-observed` per side), one edge.

Facts are observations, not conclusions — name them in past tense
(`call-observed`, `service-defined`). If a fact name sounds like a verdict
(`depends-on`), it belongs in edges instead.

## Choosing identities

`identity` is the node's permanent name: required scalar fields two
independent observers would compute identically. FQCN for a Java class,
dataset name for a dataset, corpus-relative path for a file. Never offsets
or counters. When an entity has two naming schemes (bare program name vs.
load-module member), pick one as identity; a resolver `alias`es the other
onto it.

Edges may also declare `identity` — prop names whose values keep parallel
edges distinct (e.g. the same program reading the same dataset in two job
steps: `identity: ["executionContext"]`). Omit when one edge per endpoint
pair is correct.

## Mechanics (copy this shape)

```ts
// trestle/profile.ts — inert data only; defineProfile rejects functions
import { defineProfile, t } from "trestle";

export default defineProfile({
  nodes: {
    Service:   { identity: ["name"], props: { engine: t.string().optional() } },
    JavaClass: { identity: ["fqcn"], props: { component: t.string().indexed().optional() } },
  },
  edges: {
    CALLS_SERVICE: { from: ["JavaClass"], to: ["Service"],
                     props: { dispatch: t.enum("literal", "dynamic") } },
    READS: { from: ["Program"], to: ["Dataset"],
             props: { executionContext: t.string() }, identity: ["executionContext"] },
  },
  facts: {
    "service-call-observed": { version: 1,
      props: { caller: t.string(), service: t.string(), dispatch: t.enum("literal", "dynamic") } },
  },
});
```

- Props: `t.string() | t.number() | t.boolean() | t.enum(...) | t.array(...) | t.json()`,
  chain `.optional()` / `.indexed()` (scalars only). `t.json()` is the
  pass-through escape hatch for tool payloads.
- Edge `from`/`to` must name declared node kinds; edge identity props must
  be required scalars.
- Bump a fact kind's `version` when its props change meaning; re-extract.
- `trestle profile build` writes `profile.lock.json` (commit it; the hash is
  the vocabulary revision). All other commands read the lock, so build after
  every profile edit. Undeclared kinds/props are hard errors at emit time —
  extend the profile first, then the pipeline.
