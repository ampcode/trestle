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

Each project runs in its own orb as a supervised service, exposing
an interactive **GPU-rendered graph explorer** and an **MCP endpoint through
the orb portal** so humans and agents can inspect the same live graph.

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

```sh
# Distributed through the Amp-hosted git remote (uses your Amp git
# credentials; no npm registry needed). #semver: resolves pushed v* tags.
npm install "git+https://ampcode.com/@jesse/trestle#semver:^0.1.0"
npx trestle init             # scaffolds trestle/ and .amp/services.yaml
cd trestle
npx trestle profile build    # compile profile.ts -> profile.lock.json
npx trestle extract          # run extraction pipeline -> facts
npx trestle resolve          # run resolvers -> nodes/edges/evidence/claims
npx trestle survey           # what is still unresolved; what to work on next
npx trestle doctor           # mechanical graph-health checks (duplication, staleness, drift)
npx trestle project build    # materialize the Cypher projection (needs @ladybugdb/core)
npx trestle project query 'MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 10'
npx trestle serve            # graph explorer at /; MCP endpoint at /mcp
```

`trestle init` declares the server in `.amp/services.yaml`. Opening the Amp
Portal tab starts it on demand, or run `amp orb services ensure`. The explorer
reads the authoritative SQLite graph directly, so it reflects the next
`extract` / `resolve` run after a browser refresh and does not require a
LadybugDB projection. Other Amp threads can attach `<portal-url>/mcp` as a
remote MCP server.

Visualization presentation is Git-tracked TypeScript in
`trestle/trestle.config.ts`:

```ts
export default {
  corpusRoots: [".."],
  visualization: {
    title: "Migration knowledge graph",
    nodes: { Program: { label: "name", color: "#9b87f5" } },
    edges: { CALLS: { color: "#42b7ff", width: 1.25 } },
  },
} satisfies TrestleConfig;
```

Unconfigured kinds get deterministic colors and identity-derived labels.
Restart the declared service after editing presentation config with
`amp orb service restart trestle`; graph data itself updates on browser refresh.

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
skills (init copies them in full into `.agents/skills/`, plus an
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
