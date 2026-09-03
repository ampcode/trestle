import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, sha256, stableHash } from "../profile/canonical.ts";
import type { Profile } from "../profile/define.ts";
import { validateIdentity, validateProps, type Scalar } from "../profile/validate.ts";
import type { Directive, NodeRef } from "../resolve/directives.ts";

/** ---------- row shapes (as returned to user code) ---------- */

export interface FactRow {
  id: number;
  kind: string;
  version: number;
  cell: string;
  sourcePath: string;
  locator: unknown;
  authority: { tool: string; version?: string; asOf?: string } | null;
  props: Record<string, unknown>;
}

export interface NodeRow {
  id: number;
  kind: string;
  identity: Record<string, Scalar>;
  stableId: string;
  props: Record<string, unknown>;
  provenance: "stub" | "declared";
  owner: string;
  createdRev: number;
}

export interface EdgeRow {
  id: number;
  kind: string;
  fromStable: string;
  toStable: string;
  identity: Record<string, Scalar>;
  stableId: string;
  props: Record<string, unknown>;
  owner: string;
  createdRev: number;
}

export interface FactInput {
  kind: string;
  sourcePath: string;
  locator?: unknown;
  authority?: { tool: string; version?: string; asOf?: string };
  props: Record<string, unknown>;
}

const DDL = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS revisions (
  rev        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS profile_snapshots (
  hash          TEXT PRIMARY KEY,
  json          TEXT NOT NULL,
  activated_rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  id           INTEGER PRIMARY KEY,
  path         TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'corpus',
  seen_rev     INTEGER NOT NULL,
  UNIQUE (path, content_hash)
);
CREATE TABLE IF NOT EXISTS memo_cells (
  key         TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  inputs      TEXT NOT NULL DEFAULT '[]',
  updated_rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  cell        TEXT NOT NULL,
  source_path TEXT NOT NULL,
  locator     TEXT,
  authority   TEXT,
  props       TEXT NOT NULL,
  created_rev INTEGER NOT NULL,
  retired_rev INTEGER
);
CREATE INDEX IF NOT EXISTS facts_kind_live ON facts (kind) WHERE retired_rev IS NULL;
CREATE INDEX IF NOT EXISTS facts_cell_live ON facts (cell) WHERE retired_rev IS NULL;
CREATE TABLE IF NOT EXISTS nodes (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  identity    TEXT NOT NULL,
  stable_id   TEXT NOT NULL,
  props       TEXT NOT NULL DEFAULT '{}',
  provenance  TEXT NOT NULL,
  owner       TEXT NOT NULL,
  created_rev INTEGER NOT NULL,
  retired_rev INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS nodes_live ON nodes (kind, stable_id) WHERE retired_rev IS NULL;
CREATE TABLE IF NOT EXISTS edges (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  from_stable TEXT NOT NULL,
  to_stable   TEXT NOT NULL,
  identity    TEXT NOT NULL DEFAULT '{}',
  stable_id   TEXT NOT NULL,
  props       TEXT NOT NULL DEFAULT '{}',
  owner       TEXT NOT NULL,
  created_rev INTEGER NOT NULL,
  retired_rev INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS edges_live ON edges (stable_id) WHERE retired_rev IS NULL;
CREATE INDEX IF NOT EXISTS edges_from_live ON edges (from_stable) WHERE retired_rev IS NULL;
CREATE INDEX IF NOT EXISTS edges_to_live ON edges (to_stable) WHERE retired_rev IS NULL;
CREATE TABLE IF NOT EXISTS evidence (
  id               INTEGER PRIMARY KEY,
  entity_type      TEXT NOT NULL,
  entity_stable    TEXT NOT NULL,
  fact_id          INTEGER,
  source_path      TEXT,
  locator          TEXT,
  resolver         TEXT NOT NULL,
  resolver_version TEXT NOT NULL DEFAULT '0',
  rule             TEXT,
  note             TEXT,
  created_rev      INTEGER NOT NULL,
  retired_rev      INTEGER
);
CREATE INDEX IF NOT EXISTS evidence_entity_live ON evidence (entity_stable) WHERE retired_rev IS NULL;
CREATE INDEX IF NOT EXISTS evidence_resolver_live ON evidence (resolver) WHERE retired_rev IS NULL;
CREATE TABLE IF NOT EXISTS aliases (
  id               INTEGER PRIMARY KEY,
  canonical_stable TEXT NOT NULL,
  alias_stable     TEXT NOT NULL,
  resolver         TEXT NOT NULL,
  created_rev      INTEGER NOT NULL,
  retired_rev      INTEGER
);
CREATE INDEX IF NOT EXISTS aliases_alias_live ON aliases (alias_stable) WHERE retired_rev IS NULL;
CREATE TABLE IF NOT EXISTS claims (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  about       TEXT NOT NULL DEFAULT '[]',
  detail      TEXT NOT NULL,
  candidates  TEXT,
  resolver    TEXT NOT NULL,
  rule        TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_rev INTEGER NOT NULL,
  retired_rev INTEGER
);
CREATE TABLE IF NOT EXISTS decisions (
  id          INTEGER PRIMARY KEY,
  claim_id    INTEGER,
  decision    TEXT NOT NULL,
  author      TEXT,
  created_rev INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
`;

export class Store {
  readonly db: DatabaseSync;
  profile: Profile | null = null;
  private activeProfileHash = "";

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(DDL);
  }

  close(): void {
    this.db.close();
  }

  /** ---------- revisions ---------- */

  beginRevision(kind: string, meta: Record<string, unknown> = {}): number {
    const r = this.db
      .prepare(`INSERT INTO revisions (kind, meta) VALUES (?, ?)`)
      .run(kind, JSON.stringify(meta));
    return Number(r.lastInsertRowid);
  }

  currentRevision(): number {
    const row = this.db.prepare(`SELECT MAX(rev) AS rev FROM revisions`).get() as { rev: number | null };
    return row.rev ?? 0;
  }

  /** ---------- profile ---------- */

  activateProfile(profile: Profile, hash: string): void {
    this.profile = profile;
    this.activeProfileHash = hash;
    const existing = this.db.prepare(`SELECT hash FROM profile_snapshots WHERE hash = ?`).get(hash);
    if (!existing) {
      const rev = this.beginRevision("profile-activation", { hash });
      const { __trestleProfile: _m, ...bare } = profile;
      this.db
        .prepare(`INSERT INTO profile_snapshots (hash, json, activated_rev) VALUES (?, ?, ?)`)
        .run(hash, canonicalJson(bare), rev);
      this.createIdentityIndexes(profile);
    }
  }

  private createIdentityIndexes(profile: Profile): void {
    for (const [kind, def] of Object.entries(profile.nodes)) {
      for (const field of def.identity) {
        const name = `ix_nodes_${sanitize(kind)}_${sanitize(field)}`;
        this.db.exec(
          `CREATE INDEX IF NOT EXISTS ${name} ON nodes (json_extract(identity, '$.${field}'))
           WHERE kind = '${kind.replaceAll("'", "''")}' AND retired_rev IS NULL`,
        );
      }
      for (const [prop, schema] of Object.entries(def.props)) {
        if ("indexed" in schema && schema.indexed) {
          const name = `ix_nodes_${sanitize(kind)}_p_${sanitize(prop)}`;
          this.db.exec(
            `CREATE INDEX IF NOT EXISTS ${name} ON nodes (json_extract(props, '$.${prop}'))
             WHERE kind = '${kind.replaceAll("'", "''")}' AND retired_rev IS NULL`,
          );
        }
      }
    }
  }

  requireProfile(): Profile {
    if (!this.profile) throw new Error("no active profile; run `trestle profile build` and re-open");
    return this.profile;
  }

  /** Hash of the active profile ("" before activation). */
  profileHash(): string {
    return this.activeProfileHash;
  }

  /** ---------- artifacts + memo cells ---------- */

  recordArtifact(path: string, contentHash: string, kind: string, rev: number): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (path, content_hash, kind, seen_rev) VALUES (?, ?, ?, ?)
         ON CONFLICT (path, content_hash) DO NOTHING`,
      )
      .run(path, contentHash, kind, rev);
  }

  getMemoCell(key: string): { fingerprint: string; inputs: { path: string; hash: string }[] } | null {
    const row = this.db.prepare(`SELECT fingerprint, inputs FROM memo_cells WHERE key = ?`).get(key) as
      | { fingerprint: string; inputs: string }
      | undefined;
    return row ? { fingerprint: row.fingerprint, inputs: JSON.parse(row.inputs) } : null;
  }

  putMemoCell(key: string, fingerprint: string, inputs: { path: string; hash: string }[], rev: number): void {
    this.db
      .prepare(
        `INSERT INTO memo_cells (key, fingerprint, inputs, updated_rev) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET fingerprint = excluded.fingerprint,
           inputs = excluded.inputs, updated_rev = excluded.updated_rev`,
      )
      .run(key, fingerprint, JSON.stringify(inputs), rev);
  }

  listMemoCellKeys(): string[] {
    return (this.db.prepare(`SELECT key FROM memo_cells ORDER BY key`).all() as { key: string }[]).map(
      (r) => r.key,
    );
  }

  deleteMemoCell(key: string): void {
    this.db.prepare(`DELETE FROM memo_cells WHERE key = ?`).run(key);
  }

  /** ---------- facts ---------- */

  insertFact(fact: FactInput, cell: string, rev: number): number {
    const profile = this.requireProfile();
    const def = profile.facts[fact.kind];
    if (!def) {
      throw new Error(
        `emit: undeclared fact kind "${fact.kind}" (declared: ${Object.keys(profile.facts).join(", ") || "none"})`,
      );
    }
    const errors = validateProps(def.props, fact.props, `fact "${fact.kind}"`);
    if (typeof fact.sourcePath !== "string" || fact.sourcePath.length === 0) {
      errors.push(`fact "${fact.kind}": sourcePath is required`);
    }
    if (errors.length > 0) throw new Error(`emit rejected:\n  - ${errors.join("\n  - ")}`);
    const r = this.db
      .prepare(
        `INSERT INTO facts (kind, version, cell, source_path, locator, authority, props, created_rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.kind,
        def.version,
        cell,
        fact.sourcePath,
        fact.locator === undefined ? null : JSON.stringify(fact.locator),
        fact.authority === undefined ? null : JSON.stringify(fact.authority),
        JSON.stringify(fact.props),
        rev,
      );
    return Number(r.lastInsertRowid);
  }

  retireFactsByCell(cell: string, rev: number): number {
    const r = this.db
      .prepare(`UPDATE facts SET retired_rev = ? WHERE cell = ? AND retired_rev IS NULL`)
      .run(rev, cell);
    return Number(r.changes);
  }

  factsByKind(kind: string): FactRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, version, cell, source_path, locator, authority, props
         FROM facts WHERE kind = ? AND retired_rev IS NULL ORDER BY id`,
      )
      .all(kind) as Record<string, unknown>[];
    return rows.map(rowToFact);
  }

  factCounts(): { kind: string; count: number }[] {
    return this.db
      .prepare(`SELECT kind, COUNT(*) AS count FROM facts WHERE retired_rev IS NULL GROUP BY kind ORDER BY count DESC`)
      .all() as { kind: string; count: number }[];
  }

  /** ---------- graph reads ---------- */

  nodeStableId(kind: string, identity: Record<string, Scalar>): string {
    return stableHash({ kind, identity });
  }

  edgeStableId(kind: string, fromStable: string, toStable: string, identity: Record<string, Scalar>): string {
    return stableHash({ kind, from: fromStable, to: toStable, identity });
  }

  liveNodes(kind?: string): NodeRow[] {
    const rows = (
      kind
        ? this.db.prepare(`SELECT * FROM nodes WHERE kind = ? AND retired_rev IS NULL ORDER BY id`).all(kind)
        : this.db.prepare(`SELECT * FROM nodes WHERE retired_rev IS NULL ORDER BY id`).all()
    ) as Record<string, unknown>[];
    return rows.map(rowToNode);
  }

  liveNodeByStable(stableId: string): NodeRow | null {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE stable_id = ? AND retired_rev IS NULL`).get(stableId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToNode(row) : null;
  }

  liveEdges(kind?: string): EdgeRow[] {
    const rows = (
      kind
        ? this.db.prepare(`SELECT * FROM edges WHERE kind = ? AND retired_rev IS NULL ORDER BY id`).all(kind)
        : this.db.prepare(`SELECT * FROM edges WHERE retired_rev IS NULL ORDER BY id`).all()
    ) as Record<string, unknown>[];
    return rows.map(rowToEdge);
  }

  liveEvidenceFor(entityStable: string): Record<string, unknown>[] {
    return this.db
      .prepare(`SELECT * FROM evidence WHERE entity_stable = ? AND retired_rev IS NULL ORDER BY id`)
      .all(entityStable) as Record<string, unknown>[];
  }

  openClaims(kind?: string): Record<string, unknown>[] {
    return (
      kind
        ? this.db
            .prepare(`SELECT * FROM claims WHERE kind = ? AND status = 'open' AND retired_rev IS NULL ORDER BY id`)
            .all(kind)
        : this.db.prepare(`SELECT * FROM claims WHERE status = 'open' AND retired_rev IS NULL ORDER BY id`).all()
    ) as Record<string, unknown>[];
  }

  /** ---------- node ref resolution ---------- */

  resolveNodeRef(ref: NodeRef): { kind: string; identity: Record<string, Scalar>; stableId: string } {
    const profile = this.requireProfile();
    let kind: string;
    let identity: Record<string, Scalar>;
    if (typeof ref === "string") {
      const idx = ref.indexOf(":");
      if (idx <= 0) throw new Error(`invalid node ref "${ref}" (expected "Kind:value")`);
      kind = ref.slice(0, idx);
      const def = profile.nodes[kind];
      if (!def) throw new Error(`node ref "${ref}": undeclared node kind "${kind}"`);
      if (def.identity.length !== 1) {
        throw new Error(
          `node ref "${ref}": kind "${kind}" has composite identity [${def.identity.join(", ")}]; use object form`,
        );
      }
      identity = { [def.identity[0]!]: ref.slice(idx + 1) };
    } else {
      kind = ref.kind;
      const def = profile.nodes[kind];
      if (!def) throw new Error(`node ref: undeclared node kind "${kind}"`);
      const errors = validateIdentity(def.identity, ref.identity, `node ref ${kind}`);
      if (errors.length > 0) throw new Error(errors.join("; "));
      identity = ref.identity;
    }
    return { kind, identity, stableId: this.nodeStableId(kind, identity) };
  }

  /** ---------- directive application (one revision, atomic) ---------- */

  applyDirectives(
    resolverName: string,
    resolverVersion: string,
    directives: Directive[],
  ): { rev: number; applied: Record<string, number> } {
    const profile = this.requireProfile();
    const rev = this.beginRevision("resolve", { resolver: resolverName, version: resolverVersion });
    const applied = { node: 0, edge: 0, alias: 0, claim: 0, evidence: 0, retired: 0 };

    this.db.exec("BEGIN");
    try {
      // 1. Retire this resolver's prior contribution (evidence, claims, aliases).
      for (const table of ["evidence", "claims", "aliases"]) {
        const r = this.db
          .prepare(`UPDATE ${table} SET retired_rev = ? WHERE resolver = ? AND retired_rev IS NULL`)
          .run(rev, resolverName);
        applied.retired += Number(r.changes);
      }

      // 2. Alias map: existing live aliases + this batch, union-find flattened.
      const parent = new Map<string, string>();
      const find = (s: string): string => {
        let cur = s;
        const seen = new Set<string>();
        while (parent.has(cur) && !seen.has(cur)) {
          seen.add(cur);
          cur = parent.get(cur)!;
        }
        return cur;
      };
      const existingAliases = this.db
        .prepare(`SELECT canonical_stable, alias_stable FROM aliases WHERE retired_rev IS NULL`)
        .all() as { canonical_stable: string; alias_stable: string }[];
      for (const a of existingAliases) parent.set(a.alias_stable, a.canonical_stable);

      for (const d of directives) {
        if (d.op !== "alias") continue;
        const canonical = this.resolveNodeRef(d.canonical);
        const alias = this.resolveNodeRef(d.alias);
        if (find(alias.stableId) === find(canonical.stableId)) continue;
        parent.set(find(alias.stableId), find(canonical.stableId));
        this.db
          .prepare(`INSERT INTO aliases (canonical_stable, alias_stable, resolver, created_rev) VALUES (?, ?, ?, ?)`)
          .run(canonical.stableId, alias.stableId, resolverName, rev);
        applied.alias++;
        this.mergeNodeInto(alias.stableId, find(canonical.stableId), rev);
      }
      const canon = (stable: string): string => find(stable);

      // 3. Node directives (declared enrichment).
      const declaredNow = new Set<string>();
      for (const d of directives) {
        if (d.op !== "node") continue;
        const def = profile.nodes[d.kind];
        if (!def) throw new Error(`directive: undeclared node kind "${d.kind}"`);
        const idErrors = validateIdentity(def.identity, d.identity, `node ${d.kind}`);
        const propErrors = validateProps(def.props, d.props ?? {}, `node ${d.kind}`);
        if (idErrors.length + propErrors.length > 0)
          throw new Error(`directive rejected:\n  - ${[...idErrors, ...propErrors].join("\n  - ")}`);
        const stable = canon(this.nodeStableId(d.kind, d.identity));
        this.upsertNode(d.kind, d.identity, stable, d.props ?? {}, "declared", resolverName, rev);
        declaredNow.add(stable);
        applied.node++;

        for (const ev of d.evidence ?? []) {
          this.db
            .prepare(
              `INSERT INTO evidence (entity_type, entity_stable, fact_id, source_path, locator,
                 resolver, resolver_version, rule, note, created_rev)
               VALUES ('node', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              stable,
              ev.factId ?? null,
              ev.sourcePath ?? null,
              ev.locator === undefined ? null : JSON.stringify(ev.locator),
              resolverName,
              resolverVersion,
              d.rule ?? null,
              d.note ?? null,
              rev,
            );
          applied.evidence++;
        }
      }

      // 4. Edge directives: auto-vivify endpoints, upsert edge, append evidence.
      for (const d of directives) {
        if (d.op !== "edge") continue;
        const def = profile.edges[d.kind];
        if (!def) throw new Error(`directive: undeclared edge kind "${d.kind}"`);
        const from = this.resolveNodeRef(d.from);
        const to = this.resolveNodeRef(d.to);
        if (!def.from.includes(from.kind))
          throw new Error(`edge ${d.kind}: from-kind "${from.kind}" not in [${def.from.join(", ")}]`);
        if (!def.to.includes(to.kind))
          throw new Error(`edge ${d.kind}: to-kind "${to.kind}" not in [${def.to.join(", ")}]`);

        const fromStable = canon(from.stableId);
        const toStable = canon(to.stableId);
        this.vivify(from.kind, from.identity, fromStable, resolverName, rev);
        this.vivify(to.kind, to.identity, toStable, resolverName, rev);

        const props: Record<string, unknown> = { ...(d.props ?? {}), ...(d.identity ?? {}) };
        const propErrors = validateProps(def.props, props, `edge ${d.kind}`);
        if (propErrors.length > 0) throw new Error(`directive rejected:\n  - ${propErrors.join("\n  - ")}`);
        const identity: Record<string, Scalar> = {};
        for (const field of def.identity) identity[field] = props[field] as Scalar;

        const stable = this.edgeStableId(d.kind, fromStable, toStable, identity);
        this.upsertEdge(d.kind, fromStable, toStable, identity, stable, props, resolverName, rev);
        applied.edge++;

        for (const ev of d.evidence) {
          this.db
            .prepare(
              `INSERT INTO evidence (entity_type, entity_stable, fact_id, source_path, locator,
                 resolver, resolver_version, rule, note, created_rev)
               VALUES ('edge', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              stable,
              ev.factId ?? null,
              ev.sourcePath ?? null,
              ev.locator === undefined ? null : JSON.stringify(ev.locator),
              resolverName,
              resolverVersion,
              d.rule ?? null,
              d.note ?? null,
              rev,
            );
          applied.evidence++;
        }
      }

      // 5. Claims.
      for (const d of directives) {
        if (d.op !== "claim") continue;
        this.db
          .prepare(
            `INSERT INTO claims (kind, about, detail, candidates, resolver, rule, created_rev)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            d.kind,
            JSON.stringify(d.about ?? []),
            d.detail,
            d.candidates ? JSON.stringify(d.candidates) : null,
            resolverName,
            d.rule ?? null,
            rev,
          );
        applied.claim++;
      }

      // 6. Cleanup: retire this resolver's edges left with no live evidence,
      //    then its stub nodes no longer referenced by any live edge.
      const orphanEdges = this.db
        .prepare(
          `UPDATE edges SET retired_rev = ? WHERE owner = ? AND retired_rev IS NULL
           AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.entity_stable = edges.stable_id AND ev.retired_rev IS NULL)`,
        )
        .run(rev, resolverName);
      applied.retired += Number(orphanEdges.changes);
      const orphanStubs = this.db
        .prepare(
          `UPDATE nodes SET retired_rev = ? WHERE owner = ? AND provenance = 'stub' AND retired_rev IS NULL
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE (e.from_stable = nodes.stable_id OR e.to_stable = nodes.stable_id) AND e.retired_rev IS NULL)
           AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.entity_stable = nodes.stable_id AND ev.retired_rev IS NULL)`,
        )
        .run(rev, resolverName);
      applied.retired += Number(orphanStubs.changes);
      //    ...and its previously declared nodes it no longer declares, once
      //    they have no live evidence and no live edge references (the
      //    declaring facts were retired, so the declaration retires with them).
      const staleDeclared = this.db
        .prepare(
          `UPDATE nodes SET retired_rev = ? WHERE owner = ? AND provenance = 'declared' AND retired_rev IS NULL
           AND stable_id NOT IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.entity_stable = nodes.stable_id AND ev.retired_rev IS NULL)
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE (e.from_stable = nodes.stable_id OR e.to_stable = nodes.stable_id) AND e.retired_rev IS NULL)`,
        )
        .run(rev, resolverName, JSON.stringify([...declaredNow]));
      applied.retired += Number(staleDeclared.changes);

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { rev, applied };
  }

  /**
   * Retire the live output of resolvers that are no longer in the active
   * set (renamed or deleted resolver files never run again, so nothing
   * else retires their contribution). Facts are cell-owned and untouched.
   * Nodes still referenced by another resolver's live edge, or still
   * carrying live evidence, are kept — mirroring the orphan cleanup in
   * applyDirectives.
   */
  retireAbandonedOwners(activeOwners: string[]): { retired: number; owners: string[] } {
    const activeJson = JSON.stringify(activeOwners);
    const abandoned = new Set<string>();
    for (const [table, col] of [
      ["nodes", "owner"],
      ["edges", "owner"],
      ["evidence", "resolver"],
      ["claims", "resolver"],
      ["aliases", "resolver"],
    ] as const) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT ${col} AS o FROM ${table}
           WHERE retired_rev IS NULL AND ${col} NOT IN (SELECT value FROM json_each(?))`,
        )
        .all(activeJson) as { o: string }[];
      for (const r of rows) abandoned.add(r.o);
    }
    if (abandoned.size === 0) return { retired: 0, owners: [] };

    const owners = [...abandoned].sort();
    const ownersJson = JSON.stringify(owners);
    const rev = this.beginRevision("resolve-retire-abandoned", { owners });
    let retired = 0;
    this.db.exec("BEGIN");
    try {
      for (const [table, col] of [
        ["evidence", "resolver"],
        ["claims", "resolver"],
        ["aliases", "resolver"],
        ["edges", "owner"],
      ] as const) {
        const r = this.db
          .prepare(
            `UPDATE ${table} SET retired_rev = ? WHERE retired_rev IS NULL
             AND ${col} IN (SELECT value FROM json_each(?))`,
          )
          .run(rev, ownersJson);
        retired += Number(r.changes);
      }
      const nodes = this.db
        .prepare(
          `UPDATE nodes SET retired_rev = ? WHERE retired_rev IS NULL
           AND owner IN (SELECT value FROM json_each(?))
           AND NOT EXISTS (SELECT 1 FROM edges e WHERE (e.from_stable = nodes.stable_id OR e.to_stable = nodes.stable_id) AND e.retired_rev IS NULL)
           AND NOT EXISTS (SELECT 1 FROM evidence ev WHERE ev.entity_stable = nodes.stable_id AND ev.retired_rev IS NULL)`,
        )
        .run(rev, ownersJson);
      retired += Number(nodes.changes);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { retired, owners };
  }

  /** Insert a stub for a referenced-but-undeclared node; no-op if a live row exists. */
  private vivify(
    kind: string,
    identity: Record<string, Scalar>,
    stableId: string,
    owner: string,
    rev: number,
  ): void {
    const existing = this.liveNodeByStable(stableId);
    if (existing) return;
    this.db
      .prepare(
        `INSERT INTO nodes (kind, identity, stable_id, props, provenance, owner, created_rev)
         VALUES (?, ?, ?, '{}', 'stub', ?, ?)`,
      )
      .run(kind, canonicalJson(identity), stableId, owner, rev);
  }

  private upsertNode(
    kind: string,
    identity: Record<string, Scalar>,
    stableId: string,
    props: Record<string, unknown>,
    provenance: "stub" | "declared",
    owner: string,
    rev: number,
  ): void {
    const existing = this.liveNodeByStable(stableId);
    if (existing) {
      const mergedProps = { ...existing.props, ...props };
      const unchanged =
        existing.provenance === provenance && canonicalJson(existing.props) === canonicalJson(mergedProps);
      if (unchanged) return;
      // update = retire + insert under the same stable_id
      this.db.prepare(`UPDATE nodes SET retired_rev = ? WHERE id = ?`).run(rev, existing.id);
      this.db
        .prepare(
          `INSERT INTO nodes (kind, identity, stable_id, props, provenance, owner, created_rev)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, canonicalJson(identity), stableId, JSON.stringify(mergedProps), provenance, owner, rev);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO nodes (kind, identity, stable_id, props, provenance, owner, created_rev)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, canonicalJson(identity), stableId, JSON.stringify(props), provenance, owner, rev);
  }

  private upsertEdge(
    kind: string,
    fromStable: string,
    toStable: string,
    identity: Record<string, Scalar>,
    stableId: string,
    props: Record<string, unknown>,
    owner: string,
    rev: number,
  ): void {
    const existing = this.db
      .prepare(`SELECT id, props FROM edges WHERE stable_id = ? AND retired_rev IS NULL`)
      .get(stableId) as { id: number; props: string } | undefined;
    if (existing) {
      const mergedProps = { ...JSON.parse(existing.props), ...props };
      if (canonicalJson(JSON.parse(existing.props)) === canonicalJson(mergedProps)) return;
      this.db.prepare(`UPDATE edges SET retired_rev = ? WHERE id = ?`).run(rev, existing.id);
      this.db
        .prepare(
          `INSERT INTO edges (kind, from_stable, to_stable, identity, stable_id, props, owner, created_rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, fromStable, toStable, canonicalJson(identity), stableId, JSON.stringify(mergedProps), owner, rev);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO edges (kind, from_stable, to_stable, identity, stable_id, props, owner, created_rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, fromStable, toStable, canonicalJson(identity), stableId, JSON.stringify(props), owner, rev);
  }

  /** Merge an alias node's observations into the canonical node (retire + re-point). */
  private mergeNodeInto(aliasStable: string, canonicalStable: string, rev: number): void {
    if (aliasStable === canonicalStable) return;
    const aliasNode = this.liveNodeByStable(aliasStable);
    if (aliasNode) {
      this.db.prepare(`UPDATE nodes SET retired_rev = ? WHERE id = ?`).run(rev, aliasNode.id);
      // Fold props into the canonical node if it exists and lacks them.
      const canonNode = this.liveNodeByStable(canonicalStable);
      if (canonNode && Object.keys(aliasNode.props).length > 0) {
        this.upsertNode(
          canonNode.kind,
          canonNode.identity,
          canonicalStable,
          { ...aliasNode.props, ...canonNode.props },
          canonNode.provenance,
          canonNode.owner,
          rev,
        );
      }
    }
    // Re-point live edges touching the alias node.
    const touching = this.db
      .prepare(`SELECT * FROM edges WHERE (from_stable = ? OR to_stable = ?) AND retired_rev IS NULL`)
      .all(aliasStable, aliasStable) as Record<string, unknown>[];
    for (const raw of touching) {
      const e = rowToEdge(raw);
      this.db.prepare(`UPDATE edges SET retired_rev = ? WHERE id = ?`).run(rev, e.id);
      const fromStable = e.fromStable === aliasStable ? canonicalStable : e.fromStable;
      const toStable = e.toStable === aliasStable ? canonicalStable : e.toStable;
      const newStable = this.edgeStableId(e.kind, fromStable, toStable, e.identity);
      this.upsertEdge(e.kind, fromStable, toStable, e.identity, newStable, e.props, e.owner, rev);
      // Re-point the edge's evidence (retire + reinsert keeps append-only history).
      const evRows = this.liveEvidenceFor(e.stableId);
      for (const ev of evRows) {
        this.db.prepare(`UPDATE evidence SET retired_rev = ? WHERE id = ?`).run(rev, ev.id as number);
        this.db
          .prepare(
            `INSERT INTO evidence (entity_type, entity_stable, fact_id, source_path, locator,
               resolver, resolver_version, rule, note, created_rev)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ev.entity_type as string,
            newStable,
            (ev.fact_id as number) ?? null,
            (ev.source_path as string) ?? null,
            (ev.locator as string) ?? null,
            ev.resolver as string,
            ev.resolver_version as string,
            (ev.rule as string) ?? null,
            (ev.note as string) ?? null,
            rev,
          );
      }
    }
    // Re-point evidence attached directly to the alias node.
    const nodeEv = this.liveEvidenceFor(aliasStable);
    for (const ev of nodeEv) {
      this.db.prepare(`UPDATE evidence SET entity_stable = ? WHERE id = ?`).run(canonicalStable, ev.id as number);
    }
  }
}

/** ---------- row mappers ---------- */

function rowToFact(row: Record<string, unknown>): FactRow {
  return {
    id: row.id as number,
    kind: row.kind as string,
    version: row.version as number,
    cell: row.cell as string,
    sourcePath: row.source_path as string,
    locator: row.locator ? JSON.parse(row.locator as string) : null,
    authority: row.authority ? JSON.parse(row.authority as string) : null,
    props: JSON.parse(row.props as string),
  };
}

function rowToNode(row: Record<string, unknown>): NodeRow {
  return {
    id: row.id as number,
    kind: row.kind as string,
    identity: JSON.parse(row.identity as string),
    stableId: row.stable_id as string,
    props: JSON.parse(row.props as string),
    provenance: row.provenance as "stub" | "declared",
    owner: row.owner as string,
    createdRev: row.created_rev as number,
  };
}

function rowToEdge(row: Record<string, unknown>): EdgeRow {
  return {
    id: row.id as number,
    kind: row.kind as string,
    fromStable: row.from_stable as string,
    toStable: row.to_stable as string,
    identity: JSON.parse(row.identity as string),
    stableId: row.stable_id as string,
    props: JSON.parse(row.props as string),
    owner: row.owner as string,
    createdRev: row.created_rev as number,
  };
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}
