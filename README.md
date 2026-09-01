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
an interactive **AntV G6VP** frontend and an **MCP endpoint through
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

Requires Node ≥ 23.6 (native TypeScript type stripping and `node:sqlite`).

**This repository IS the graph repo.** There is no separate install, no npm
registry, and no `trestle init`: fork (or clone) this repo, add the code
under analysis as pinned shallow submodules under `corpora/`, and edit the
committed user surface at the root (`profile.ts`, `extract/pipeline.ts`,
`resolvers/*.ts`). The analyzed repos are never modified.

```sh
git clone <your-fork> graph-repo && cd graph-repo
./.agents/setup              # node version check, submodules, npm install (orbs run this automatically)
npx trestle corpus add https://github.com/apache/ofbiz-framework
                             # estate as a shallow submodule under corpora/
npx trestle profile build    # compile profile.ts -> profile.lock.json
npx trestle extract          # run extraction pipeline -> facts
npx trestle resolve          # run resolvers -> nodes/edges/evidence/claims
npx trestle survey           # what is still unresolved; what to work on next
npx trestle doctor           # mechanical graph-health checks (duplication, staleness, drift)
npx trestle project build    # materialize the Cypher projection (needs @ladybugdb/core)
npx trestle project query 'MATCH (a)-[r]->(b) RETURN a, r, b LIMIT 10'
npx trestle serve            # graph explorer at /; MCP endpoint at /mcp
```

`trestle serve` is the project's query endpoint. The committed
`.amp/services.yaml` declares it as a supervised orb service: opening the
Amp Portal tab starts it on demand, or run `amp orb services ensure`. The
G6VP canvas at `/` reads the authoritative SQLite graph directly, so it
reflects the next `extract` / `resolve` run after a browser refresh and does
not require a LadybugDB projection. It provides force-directed and structured
layouts, lasso selection, element highlighting, details, a mini-map, legends,
tooltips, and PNG/CSV/JSON export. The `/api/query` endpoint and MCP
`graph_query` tool run Cypher against the optional LadybugDB projection. Other
Amp threads can attach `<portal-url>/mcp` as a remote MCP server — or POST
JSON-RPC directly — to query the knowledge graph without entering the orb.

Visualization presentation is Git-tracked TypeScript in
`trestle.config.ts`:

```ts
export default {
  corpusRoots: ["corpora"],
  visualization: {
    title: "Migration knowledge graph",
    nodes: { Program: { label: "name", color: "#9b87f5" } },
    edges: { CALLS: { color: "#42b7ff", width: 1.25 } },
  },
} satisfies TrestleConfig;
```

Unconfigured kinds use stable G6VP colors and identity-derived labels.
Restart the declared service after editing presentation config with
`amp orb service restart trestle`; graph data itself updates on browser refresh.
`trestle.config.ts` remains the Git-tracked source for project presentation.

The bundled frontend uses G6VP's Apache-2.0-licensed `@antv/gi-sdk` and basic
asset library. Its pinned source, dependency lock, license, and reproducible
build instructions are retained in `src/viz/upstream/`.

### Upgrading

Git is the distribution channel. To pick up new engine versions, merge
upstream into your fork:

```sh
git remote add upstream https://ampcode.com/@jesse/trestle   # once
git fetch upstream
git merge upstream/main
```

Your project-owned files (`profile.ts`, `extract/`, `resolvers/`, `corpora/`)
live beside the engine (`src/`) and rarely conflict.

The loop is: edit `profile.ts` / `extract/pipeline.ts` / `resolvers/*.ts`,
re-run `extract` + `resolve` (both incremental and idempotent), read `survey`,
repeat. The committed `AGENTS.md` teaches this loop to coding agents, the
version-matched skills live in `.agents/skills/`, and the committed
`.amp/plugins/trestle.ts` Amp plugin — `trestle_auth` / `trestle_query` /
`trestle_call` — lets threads query a graph portal directly.

Developing the engine (same repo, `src/` + `tests/`):

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
