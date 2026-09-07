---
name: trestle-visualizing
description: Configures Trestle's bundled graph explorer for readable, semantically meaningful views. Use when creating the graph frontend, editing visualization config, choosing node and edge pools, or diagnosing crowded or blank canvases.
---

# Presenting a Trestle graph

Use the bundled frontend served by `trestle serve`; do not build a separate app
just to display the graph. Read the project's `trestle.config.mts` (or legacy
`.ts` config), its configured profile, and actual graph counts before choosing
presentation. Keep corpus, extraction, resolver, and state paths intact when
editing the `visualization` section.

In new projects, commands run from the repository root as
`npx --prefix trestle trestle ...`; typecheck with
`npm --prefix trestle run typecheck`. The analyzed code need not be TypeScript.

## Choose the view from its meaning

Start with the question the landing view should answer, not the total number of
extracted files. Identify the primary entities, supporting entities, and
relationships that answer it using real kinds and properties from the profile.

- Architecture: emphasize modules/services and dependencies; hide file-level
  inventory when it obscures those relationships.
- Program or job flow: emphasize programs/jobs and calls or execution order;
  include datasets when reads/writes are relevant to the question.
- Data impact: emphasize datasets and their readers/writers; do not hide the
  endpoints that explain an important relationship.
- File inventory: treat it as an inventory, not an architecture diagram. Do not
  invent dependencies, containment, or semantic entities to make it attractive.

Choose 3–6 visually distinct kinds when the vocabulary permits. Keep the
primary kinds visible and distinguish supporting detail with smaller nodes and
quieter colors. Kind names in examples are illustrative, not a vocabulary to
add without source evidence.

## Size the visible node and edge pools

The visible pool is the data passed to the canvas, not the whole stored graph.
Inspect `/api/graph` from the running service: it includes all live nodes/edges
and the visualization config. Count by kind and count the proposed visible view:

1. Remove nodes whose kind has `hidden: true`.
2. Retain edges only when their kind is not hidden and both endpoints remain.
3. Count nodes, edges, and disconnected nodes after those filters. Header totals
   describe the full store; they are not a count of what the canvas displays.

As a readability starting point, aim for roughly 30–150 nodes and no more than
about 2–3 edges per visible node. These are design heuristics, not engine limits.
A small meaningful graph is better than filling a budget. Dense cross-links can
overwhelm even a small node pool; hide secondary relationship kinds before
shrinking every node. Never hide every kind just to satisfy a budget.

Current limits matter: the bundled G6VP initializer takes a large-data path
above 2,000 visible nodes and can leave the ordinary canvas empty. There is no
separate edge-count threshold, and 2,000 is not a readability target. Trestle's
public config currently has no `maxNodes`, `maxEdges`, `largeGraphLimit`, pool
quota, property filter, or initial-subgraph option. Do not invent these fields
or promise they work. Per-kind hiding runs before the initializer; hiding edges
alone cannot avoid its node threshold.

If a single necessary kind has thousands of entities, kind hiding is not an
adequate solution. Report the need for a supported bounded-subgraph/filtering
feature rather than arbitrarily dropping entities, clearing the graph store,
or weakening extraction to make the frontend fit. Keep the full graph queryable.

## Configure visual hierarchy

Supported fields are `visualization.title`, node-kind `label`, `color`, `size`,
`hidden`, and edge-kind `color`, `width`, `hidden`.

- Labels: choose a short, existing identity/property field such as `name`.
  Verify representative values; absent fields fall back to identity text.
  Do not point labels at nonexistent `shortName` properties or rename identities
  for display. Paths can be useful for inventory but crowd architecture views.
- Node size: a relative multiplier, not a node count or radius. The base diameter
  is 30 pixels. Start with primary kinds at 1.2–1.5, ordinary entities at 1,
  and supporting detail at 0.7–0.9. Use finite positive numbers; use `hidden`,
  not size zero, to omit a kind. Larger nodes do not fix an oversized pool.
- Edge width: pixels, not an edge-count budget. Start with principal relations
  at 1.5–2 and contextual relations at 0.8–1.2. Keep edges quieter than nodes;
  reserve an accent color for the relationship central to the question.
- Colors: assign a stable color per semantic kind rather than relying on the
  automatic palette's kind ordering. Use a few distinguishable colors with
  contrast against the dark canvas. Retain readable labels and the legend so
  color is not the only distinction. Do not imply risk/confidence with colors
  unless the data actually supports that meaning.

Example for an existing program/data-flow vocabulary; merge only this
`visualization` object into the project's config and adapt it to real kinds:

```ts
import type { VisualizationConfig } from "trestle";

const visualization = {
  title: "Program and dataset dependencies",
  nodes: {
    Program: { label: "name", color: "#a78bfa", size: 1.3 },
    Dataset: { label: "name", color: "#5eead4", size: 1 },
    Job: { label: "name", color: "#fbbf24", size: 0.85 },
    File: { hidden: true },
  },
  edges: {
    CALLS: { color: "#94a3b8", width: 1.5 },
    WRITES: { color: "#5eead4", width: 1.8 },
    READS: { color: "#64748b", width: 1 },
    CONTAINS: { hidden: true },
  },
} satisfies VisualizationConfig;
```

Only hide File/CONTAINS in this example if they are supporting inventory, not
the question's primary evidence. Hidden entities remain in SQLite and queries;
their incident edges disappear from the canvas, not from the store.

## Display and verify

1. Typecheck the config. Presentation-only edits do not require extraction,
   resolution, or `project build`: the explorer reads live SQLite data.
2. Start the configured service with `amp orb services ensure`; after a config
   edit restart `trestle` with `amp orb service restart trestle`. Share the
   returned portal URL, not a sandbox-local address. Outside an orb, use
   `npx --prefix trestle trestle serve`.
3. Inspect the rendered view at the normal landing zoom: readable labels,
   distinguishable primary/supporting nodes, visible important relationships,
   no giant empty canvas or large-data warning, and no pile of tiny dots after
   auto-fit. Check a representative dense view and a disconnected inventory.
4. The current initial layout is fixed Dagre left-to-right. It suits directed
   flows, not thousands of isolated files. The toolbar offers Grid for an
   inventory, force layouts for cross-linked networks, and Dagre for hierarchy.
   These are interactive choices, not persisted project config fields. Do not
   claim a manual layout switch fixes the default on the next reload.
5. Click representative nodes/edges and verify details, labels, and endpoints.
   Capture and inspect a screenshot; report visible pool counts separately from
   full-store totals, the semantic selection rationale, and remaining limits.

If the graph is file-only or too large for the current frontend, say so. A
successful `/health` response or a header showing node counts does not establish
that the graph is displayed usefully.
