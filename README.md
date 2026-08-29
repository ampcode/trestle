# Trestle

Trestle is a **metaharness**: the context and orchestration layer for a
knowledge-graph-based automated code migration factory.

It is not a migration tool for any particular language. It is the small,
strongly-modeled core that project-specific migrations plug into:

- a **knowledge graph** with a user-declared ontology, populated by custom
  parsers and enriched by custom resolvers, where every edge carries evidence,
  provenance, and confidence;
- a **projection engine** that derives regenerable views (migration-unit
  candidates, scheduling DAGs, search indexes, graph-DB materializations) from
  the evidence graph without ever overwriting it;
- an **orchestration ledger** that binds migration units to durable Amp
  threads, schedules work over a dependency frontier, and gates completion on
  verifiable evidence;
- a **customization surface** of Git-tracked profiles, Amp skills, and Amp
  plugins through which users encode project-specific knowledge.

Each migration project runs in its own orb as a supervised service, exposing
an **MCP endpoint through the orb portal** so any other Amp thread can attach
it as a remote MCP server and query the knowledge graph and ledger.

Target use cases:

1. Mainframe modernization and decommission (COBOL/JCL/BMS → modern stack)
2. Mapping legacy or proprietary codebases that lack modern developer tooling
3. Java monolith modularization into containerized submodules

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Quickstart

Requires Node ≥ 24 (native TypeScript type stripping and `node:sqlite`).
Trestle has zero runtime dependencies.

```sh
npm install trestle          # in your host repo
npx trestle init             # scaffolds trestle/ (config, profile, extract, resolvers)
cd trestle
npx trestle profile build    # compile profile.ts -> profile.lock.json
npx trestle extract          # run extraction pipeline -> facts
npx trestle resolve          # run resolvers -> nodes/edges/evidence/claims
npx trestle survey           # what is still unresolved; what to work on next
npx trestle project build    # materialize the Cypher projection (needs @ladybugdb/core)
npx trestle project query 'MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 10'
```

The loop is: edit `profile.ts` / `extract/pipeline.ts` / `resolvers/*.ts`,
re-run `extract` + `resolve` (both incremental and idempotent), read `survey`,
repeat. `AGENTS.md` in the scaffold teaches this loop to coding agents, and
`trestle skills list|get <name>` serves the packaged, version-matched agent
skills (init also writes `.agents/skills/` stubs pointing at them).

Developing trestle itself:

```sh
npm install
npm test                     # node --test tests/*.test.ts
npx tsc --noEmit
```

## Prior art

Trestle generalizes two earlier experiments:

- [strangler-fig](https://github.com/JEdelstein25/strangler-fig) — mainframe
  evidence-graph extraction and migration-boundary discovery. Trestle inherits
  its fact bus, external-process parser contract, two-stage
  parse-then-resolve pipeline, and evidence/projection separation — and
  replaces its closed COBOL ontology with a profile-declared one.
- [ampxtra](https://github.com/JEdelstein25/ampxtra) (`ampx`) — a
  project-scoped coordination ledger for long-running migrations over Amp
  thread actors. Trestle inherits its canonical-ownership discipline, durable
  unit threads, reserve→provision→self-bind handshake, verification-gated
  completion, and liveness driver.
