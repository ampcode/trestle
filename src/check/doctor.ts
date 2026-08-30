/**
 * `trestle doctor`: mechanical graph-health checks.
 *
 * Every check here is structural and vocabulary-free — it must hold for any
 * profile, or it does not belong in the kernel. The checks catch the drift
 * the store's own uniqueness constraints cannot see: near-duplicate
 * identities that should have been normalized or alias-merged, edges whose
 * evidence or endpoints have been retired out from under them, double
 * transcription, and graph state that is stale relative to the facts.
 *
 * Severity: an `error` means the graph lies (something references retired
 * or undeclared state); a `warn` means the graph is noisy (duplication that
 * dilutes queries but does not falsify them).
 */
import type { Store } from "../store/store.ts";

export interface DoctorFinding {
  id: string;
  severity: "error" | "warn";
  title: string;
  count: number;
  samples: string[];
  remedy: string;
}

export interface DoctorReport {
  revision: number;
  findings: DoctorFinding[]; // every check, including passing ones (count 0)
  errors: number;
  warnings: number;
}

const SAMPLE_LIMIT = 5;

/** Normalization used only to *detect* near-duplicates, never to rewrite. */
function normalizeScalar(v: unknown): string {
  return String(v).trim().toLowerCase().replaceAll("\\", "/").replace(/\s+/g, " ");
}

export function runDoctor(store: Store): DoctorReport {
  const db = store.db;
  const profile = store.requireProfile();
  const findings: DoctorFinding[] = [];
  const add = (
    id: string,
    severity: "error" | "warn",
    title: string,
    remedy: string,
    rows: string[],
    count = rows.length,
  ): void => {
    findings.push({ id, severity, title, count, samples: rows.slice(0, SAMPLE_LIMIT), remedy });
  };

  // ---- E1: orphan edges (endpoint has no live node) ----
  // The store auto-vivifies stubs at apply time, so a live edge with a dead
  // endpoint means retirement drift between resolver runs.
  {
    const rows = db
      .prepare(
        `SELECT e.kind, e.stable_id FROM edges e WHERE e.retired_rev IS NULL AND (
           NOT EXISTS (SELECT 1 FROM nodes n WHERE n.stable_id = e.from_stable AND n.retired_rev IS NULL)
           OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.stable_id = e.to_stable AND n.retired_rev IS NULL))`,
      )
      .all() as { kind: string; stable_id: string }[];
    add(
      "orphan-edges",
      "error",
      "live edges with a retired or missing endpoint node",
      "re-run resolve; if persistent, a resolver retires nodes another resolver's edges depend on",
      rows.map((r) => `${r.kind} ${r.stable_id}`),
    );
  }

  // ---- E2: stale evidence (cites a retired or missing fact) ----
  {
    const rows = db
      .prepare(
        `SELECT ev.entity_type, ev.entity_stable, ev.resolver FROM evidence ev
         WHERE ev.retired_rev IS NULL AND ev.fact_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = ev.fact_id AND f.retired_rev IS NULL)`,
      )
      .all() as { entity_type: string; entity_stable: string; resolver: string }[];
    add(
      "stale-evidence",
      "error",
      "live evidence citing retired or missing facts (graph is stale relative to extraction)",
      "run resolve so resolvers re-read the current facts",
      rows.map((r) => `${r.entity_type} ${r.entity_stable} (resolver ${r.resolver})`),
    );
  }

  // ---- E3: vocabulary drift (live rows of kinds the profile no longer declares) ----
  {
    const drifted: string[] = [];
    const kindsOf = (table: string): string[] =>
      (db.prepare(`SELECT DISTINCT kind FROM ${table} WHERE retired_rev IS NULL`).all() as { kind: string }[]).map(
        (r) => r.kind,
      );
    for (const kind of kindsOf("nodes")) if (!(kind in profile.nodes)) drifted.push(`node kind ${kind}`);
    for (const kind of kindsOf("edges")) if (!(kind in profile.edges)) drifted.push(`edge kind ${kind}`);
    for (const kind of kindsOf("facts")) if (!(kind in profile.facts)) drifted.push(`fact kind ${kind}`);
    add(
      "vocabulary-drift",
      "error",
      "live rows whose kind is absent from the active profile",
      "re-run extract + resolve after profile changes so owners retire their old output",
      drifted,
    );
  }

  // ---- W1: near-duplicate node identities ----
  // Same kind, identities equal after case/whitespace/path-separator
  // normalization, not already linked by a live alias.
  {
    const canon = new Map<string, string>(); // union-find over live aliases
    const find = (x: string): string => {
      const parent = canon.get(x);
      if (parent === undefined || parent === x) return parent ?? x;
      const root = find(parent);
      canon.set(x, root);
      return root;
    };
    const union = (a: string, b: string): void => {
      canon.set(find(a), find(b));
    };
    const aliasRows = db
      .prepare(`SELECT canonical_stable, alias_stable FROM aliases WHERE retired_rev IS NULL`)
      .all() as { canonical_stable: string; alias_stable: string }[];
    for (const a of aliasRows) union(a.alias_stable, a.canonical_stable);

    const groups = new Map<string, { stableId: string; identity: string }[]>();
    for (const n of store.liveNodes()) {
      const key = `${n.kind}\u0000${Object.entries(n.identity)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${normalizeScalar(v)}`)
        .join("\u0000")}`;
      const group = groups.get(key) ?? [];
      group.push({ stableId: n.stableId, identity: `${n.kind} ${JSON.stringify(n.identity)}` });
      groups.set(key, group);
    }
    const dupes: string[] = [];
    let count = 0;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const roots = new Set(group.map((m) => find(m.stableId)));
      if (roots.size < 2) continue; // already alias-unified
      count++;
      dupes.push(group.map((m) => m.identity).join("  <->  "));
    }
    add(
      "near-duplicate-identities",
      "warn",
      "distinct live nodes whose identities differ only by case/whitespace/path separators",
      "normalize identities in the resolver, or alias-merge if genuinely the same entity",
      dupes,
      count,
    );
  }

  // ---- W2/W3: entities without evidence ----
  {
    const edges = db
      .prepare(
        `SELECT e.kind, e.stable_id FROM edges e WHERE e.retired_rev IS NULL AND NOT EXISTS
           (SELECT 1 FROM evidence ev WHERE ev.entity_stable = e.stable_id AND ev.retired_rev IS NULL)`,
      )
      .all() as { kind: string; stable_id: string }[];
    add(
      "edges-without-evidence",
      "warn",
      "live edges with no live evidence",
      "the emitting resolver should cite evidence; re-run resolve if evidence was retired",
      edges.map((r) => `${r.kind} ${r.stable_id}`),
    );

    const nodes = db
      .prepare(
        `SELECT n.kind, n.identity FROM nodes n WHERE n.retired_rev IS NULL AND n.provenance = 'declared'
           AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.entity_stable = n.stable_id AND ev.retired_rev IS NULL)`,
      )
      .all() as { kind: string; identity: string }[];
    add(
      "declared-nodes-without-evidence",
      "warn",
      "declared live nodes with no live evidence (stubs are exempt)",
      "declare nodes with evidence so every assertion traces to bytes",
      nodes.map((r) => `${r.kind} ${r.identity}`),
    );
  }

  // ---- W4: duplicate facts (double transcription) ----
  {
    const rows = db
      .prepare(
        `SELECT kind, source_path, COUNT(*) AS copies, COUNT(DISTINCT cell) AS cells FROM facts
         WHERE retired_rev IS NULL GROUP BY kind, source_path, IFNULL(locator, ''), props
         HAVING COUNT(*) > 1`,
      )
      .all() as { kind: string; source_path: string; copies: number; cells: number }[];
    add(
      "duplicate-facts",
      "warn",
      "identical live facts transcribed more than once (inflates evidence counts)",
      "two pipeline cells transcribe the same thing; scope cells so each artifact region has one owner",
      rows.map((r) => `${r.kind} @ ${r.source_path} x${r.copies} (${r.cells} cells)`),
    );
  }

  // ---- W5: duplicate evidence rows ----
  {
    const rows = db
      .prepare(
        `SELECT entity_stable, resolver, COUNT(*) AS copies FROM evidence
         WHERE retired_rev IS NULL
         GROUP BY entity_stable, IFNULL(fact_id, -1), resolver, IFNULL(rule, '')
         HAVING COUNT(*) > 1`,
      )
      .all() as { entity_stable: string; resolver: string; copies: number }[];
    add(
      "duplicate-evidence",
      "warn",
      "identical live evidence rows (same entity, fact, resolver, rule)",
      "the resolver cites the same fact twice for one directive; deduplicate before emitting",
      rows.map((r) => `${r.entity_stable} x${r.copies} (resolver ${r.resolver})`),
    );
  }

  // ---- W6: identity hygiene ----
  {
    const dirty: string[] = [];
    for (const n of store.liveNodes()) {
      for (const [field, value] of Object.entries(n.identity)) {
        const s = String(value);
        if (s === "" || s !== s.trim()) dirty.push(`${n.kind} ${field}=${JSON.stringify(s)}`);
      }
    }
    add(
      "identity-hygiene",
      "warn",
      "identity values that are empty or carry leading/trailing whitespace",
      "trim in the extractor or resolver; whitespace variants become silent near-duplicates",
      dirty,
    );
  }

  // ---- W7: alias hygiene ----
  {
    const rows = db
      .prepare(
        `SELECT a.canonical_stable, a.alias_stable FROM aliases a WHERE a.retired_rev IS NULL AND (
           NOT EXISTS (SELECT 1 FROM nodes n WHERE n.stable_id = a.canonical_stable AND n.retired_rev IS NULL)
           OR NOT EXISTS (SELECT 1 FROM nodes n WHERE n.stable_id = a.alias_stable AND n.retired_rev IS NULL))`,
      )
      .all() as { canonical_stable: string; alias_stable: string }[];
    add(
      "dangling-aliases",
      "warn",
      "live aliases whose canonical or alias node is no longer live",
      "re-run the alias-emitting resolver; retire aliases whose nodes are gone",
      rows.map((r) => `${r.alias_stable} -> ${r.canonical_stable}`),
    );
  }

  const errors = findings.filter((f) => f.severity === "error" && f.count > 0).length;
  const warnings = findings.filter((f) => f.severity === "warn" && f.count > 0).length;
  return { revision: store.currentRevision(), findings, errors, warnings };
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = [`doctor @ revision ${report.revision}`];
  for (const f of report.findings) {
    const mark = f.count === 0 ? "ok " : f.severity === "error" ? "ERR" : "warn";
    lines.push(`  [${mark}] ${f.id}: ${f.count === 0 ? "clean" : `${f.count} — ${f.title}`}`);
    if (f.count > 0) {
      for (const s of f.samples) lines.push(`        ${s}`);
      if (f.count > f.samples.length) lines.push(`        … ${f.count - f.samples.length} more`);
      lines.push(`        remedy: ${f.remedy}`);
    }
  }
  lines.push(
    report.errors + report.warnings === 0
      ? "graph is healthy"
      : `${report.errors} error check(s), ${report.warnings} warning check(s) failing`,
  );
  return lines.join("\n");
}
