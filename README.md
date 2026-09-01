# Trestle

Trestle is a **knowledge graph harness** for code migration and comprehension.

It is not a migration tool for any particular language, and it is not an
orchestrator. It is the small, strongly-modeled core that project-specific
graph construction plugs into:

- a **knowledge graph** with a user-declared ontology, populated by custom
  extraction pipelines and enriched by custom resolvers, where every edge
  carries evidence, provenance, and confidence;
- a **projection engine** that derives regenerable views (boundary
  candidates, search indexes, Cypher graph-DB materializations) from the
  evidence graph without ever overwriting it;
- a **serving surface** (MCP over the orb portal, CLI, Amp plugin) through
  which coding agents, humans, and external orchestrators query the graph;
- a **customization surface** of Git-tracked profiles, user TypeScript
  programs, and Amp skills through which users encode project-specific
  knowledge.

Each project runs in its own orb as a supervised service, exposing an **MCP
endpoint through the orb portal** so any other Amp thread can attach it as a
remote MCP server and query the knowledge graph.

**Orchestration is deliberately out of scope.** Trestle constructs and serves
the graph; deciding what to migrate, binding work to agent threads, and
tracking execution status belong to an external orchestrator (such as ampx)
that consumes the graph read-only. See ARCHITECTURE.md §4–5 for the consumer
contract.

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
npx trestle doctor           # mechanical graph-health checks (duplication, staleness, drift)
npx trestle project build    # materialize the Cypher projection (needs @ladybugdb/core)
npx trestle project query 'MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 10'
npx trestle serve         # MCP server (graph_query, survey, status, doctor) for other threads
```

`trestle serve` is the factory's query endpoint: run it as a supervised
service in the project orb (`amp orb service start trestle-mcp --command
'npx trestle serve' --portal`) and any Amp thread can attach the portal URL
as a remote MCP server — or POST JSON-RPC directly — to query the knowledge
graph without entering the orb.

### Installing from a Git clone

To deploy trestle from a clone instead of the npm registry, use a `file:`
install so npm owns the link and preserves it across future installs:

```sh
npm install /path/to/trestle-clone   # symlink managed by npm, not pruned
```

Do not hand-create `node_modules/trestle` with `ln -s` — `npm install`
prunes symlinks it did not create. Optional deps such as `@ladybugdb/core`
are still installed in the host repo: trestle resolves them from the
invoking project even when trestle itself is deployed as a symlink.

The loop is: edit `profile.ts` / `extract/pipeline.ts` / `resolvers/*.ts`,
re-run `extract` + `resolve` (both incremental and idempotent), read `survey`,
repeat. `AGENTS.md` in the scaffold teaches this loop to coding agents, and
`trestle skills list|get <name>` serves the packaged, version-matched agent
skills (init also writes `.agents/skills/` stubs pointing at them, plus an
`.amp/plugins/trestle.ts` Amp plugin — `trestle_auth` / `trestle_query` /
`trestle_call` — so threads in the host repo can query a graph portal
directly).

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
  thread actors. The reference external orchestrator: Trestle inherits its
  canonical-ownership discipline and serves it the graph; ampx owns units,
  bindings, and execution status.
