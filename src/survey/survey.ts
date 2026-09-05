import type { Store } from "../store/store.ts";

export interface Survey {
  revision: number;
  facts: { kind: string; count: number }[];
  nodes: { kind: string; provenance: string; count: number }[];
  edges: { kind: string; count: number; evidence: number }[];
  claims: { kind: string; count: number }[];
  stubs: { kind: string; identity: string; inbound: number }[];
}

/** P7: tabulate the population — what exists, what is stub, what is unexplained. */
export function computeSurvey(store: Store): Survey {
  const db = store.db;
  return {
    revision: store.currentRevision(),
    facts: store.factCounts(),
    // SAFETY: kind/provenance are NOT NULL TEXT; COUNT returns a number with SQLite's default integer mode.
    nodes: db
      .prepare(
        `SELECT kind, provenance, COUNT(*) AS count FROM nodes WHERE retired_rev IS NULL
         GROUP BY kind, provenance ORDER BY kind, provenance`,
      )
      .all() as Survey["nodes"],
    // SAFETY: kind is NOT NULL TEXT and both aggregate aliases are COUNTs (numbers, including zero).
    edges: db
      .prepare(
        `SELECT e.kind, COUNT(DISTINCT e.id) AS count, COUNT(ev.id) AS evidence
         FROM edges e LEFT JOIN evidence ev ON ev.entity_stable = e.stable_id AND ev.retired_rev IS NULL
         WHERE e.retired_rev IS NULL GROUP BY e.kind ORDER BY count DESC`,
      )
      .all() as Survey["edges"],
    // SAFETY: kind is NOT NULL TEXT and COUNT is returned as a number.
    claims: db
      .prepare(
        `SELECT kind, COUNT(*) AS count FROM claims WHERE status = 'open' AND retired_rev IS NULL
         GROUP BY kind ORDER BY count DESC`,
      )
      .all() as Survey["claims"],
    // SAFETY: node kind/identity are NOT NULL TEXT; COUNT(e.id) is numeric even without joined edges.
    stubs: (
      db
        .prepare(
          `SELECT n.kind, n.identity, COUNT(e.id) AS inbound
           FROM nodes n LEFT JOIN edges e ON (e.to_stable = n.stable_id OR e.from_stable = n.stable_id) AND e.retired_rev IS NULL
           WHERE n.provenance = 'stub' AND n.retired_rev IS NULL
           GROUP BY n.id ORDER BY inbound DESC, n.kind LIMIT 20`,
        )
        .all() as { kind: string; identity: string; inbound: number }[]
    ).map((r) => ({ ...r, identity: r.identity })),
  };
}

export function renderSurvey(s: Survey): string {
  const lines: string[] = [];
  lines.push(`survey @ revision ${s.revision}`);
  lines.push("");
  lines.push("facts (live):");
  for (const f of s.facts) lines.push(`  ${f.kind.padEnd(28)} ${f.count}`);
  if (s.facts.length === 0) lines.push("  (none — run `trestle extract`)");
  lines.push("");
  lines.push("nodes:");
  for (const n of s.nodes) lines.push(`  ${n.kind.padEnd(20)} ${n.provenance.padEnd(10)} ${n.count}`);
  if (s.nodes.length === 0) lines.push("  (none — run `trestle resolve`)");
  lines.push("");
  lines.push("edges:");
  for (const e of s.edges) lines.push(`  ${e.kind.padEnd(20)} ${String(e.count).padEnd(8)} evidence: ${e.evidence}`);
  if (s.edges.length === 0) lines.push("  (none)");
  lines.push("");
  lines.push("open claims:");
  for (const c of s.claims) lines.push(`  ${c.kind.padEnd(28)} ${c.count}`);
  if (s.claims.length === 0) lines.push("  (none)");
  if (s.stubs.length > 0) {
    lines.push("");
    lines.push("stub nodes (referenced but never declared — what do we not know?):");
    for (const st of s.stubs) lines.push(`  ${st.kind.padEnd(20)} ${st.identity.padEnd(40)} edges: ${st.inbound}`);
  }
  return lines.join("\n");
}
