import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson, stableHash } from "../profile/canonical.ts";
import type { Profile } from "../profile/define.ts";
import { validateIdentity, validateProps, isScalar, type Scalar } from "../profile/validate.ts";
import { isString, type JsonValue, type Properties } from "../profile/value.ts";
import type { Directive, NodeRef } from "../resolve/directives.ts";

/** ---------- row shapes (as returned to user code) ---------- */

export interface FactRow {
  id: number;
  kind: string;
  version: number;
  cell: string;
  sourcePath: string;
  locator: JsonValue;
  authority: { tool: string; version?: string; asOf?: string } | null;
  props: Properties;
}

export interface NodeRow {
  id: number;
  kind: string;
  identity: Record<string, Scalar>;
  stableId: string;
  props: Properties;
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
  props: Properties;
  owner: string;
  createdRev: number;
}

export interface FactInput {
  kind: string;
  sourcePath: string;
  locator?: JsonValue;
  authority?: { tool: string; version?: string; asOf?: string };
  props: Properties;
}

/** SQLite read contracts. JSON columns stay serialized until mapped to the public API. */
type StoredFact = Omit<FactRow, "sourcePath" | "locator" | "authority" | "props"> & {
  source_path: string;
  locator: string | null;
  authority: string | null;
  props: string;
};

type StoredNode = Omit<NodeRow, "identity" | "stableId" | "props" | "createdRev"> & {
  identity: string;
  stable_id: string;
  props: string;
  created_rev: number;
};

type StoredEdge = Omit<EdgeRow, "fromStable" | "toStable" | "identity" | "stableId" | "props" | "createdRev"> & {
  from_stable: string;
  to_stable: string;
  identity: string;
  stable_id: string;
  props: string;
  created_rev: number;
};

export type StoredEvidence = {
  id: number;
  entity_type: "node" | "edge";
  entity_stable: string;
  fact_id: number | null;
  source_path: string | null;
  locator: string | null;
  resolver: string;
  resolver_version: string;
  rule: string | null;
  note: string | null;
  created_rev: number;
  retired_rev: number | null;
};

export type StoredClaim = {
  id: number;
  kind: string;
  about: string;
  detail: string;
  candidates: string | null;
  resolver: string;
  rule: string | null;
  status: string;
  created_rev: number;
  retired_rev: number | null;
};

const DDL = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS store_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL DEFAULT 0,
  profile_hash TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO store_state (id) VALUES (1);
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
    this.initializeContributions();
    // Triggers cover every writer, including direct SQL. Their increments commit
    // or roll back with the data; allocating a run/revision is not a mutation.
    for (const table of ["facts", "nodes", "edges", "evidence", "aliases", "claims", "decisions", "profile_snapshots", "entity_contributions"]) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        this.db.exec(`CREATE TRIGGER IF NOT EXISTS generation_${table}_${operation}
          AFTER ${operation} ON ${table} BEGIN
            UPDATE store_state SET generation = generation + 1 WHERE id = 1;
          END`);
      }
    }
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS generation_profile
      AFTER UPDATE OF profile_hash ON store_state WHEN OLD.profile_hash != NEW.profile_hash BEGIN
        UPDATE store_state SET generation = generation + 1 WHERE id = 1;
      END`);
  }

  private initializeContributions(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entity_contributions'").get();
      if (!exists) {
        this.db.exec(`CREATE TABLE entity_contributions (
          entity_type TEXT NOT NULL,
          entity_stable TEXT NOT NULL,
          resolver TEXT NOT NULL,
          props TEXT NOT NULL,
          source_stable TEXT NOT NULL,
          PRIMARY KEY (entity_type, entity_stable, resolver, source_stable)
        );
        CREATE INDEX contributions_resolver ON entity_contributions (resolver);
        INSERT INTO entity_contributions
          SELECT 'node', stable_id, owner, props, stable_id FROM nodes WHERE retired_rev IS NULL AND provenance = 'declared';
        INSERT INTO entity_contributions
          SELECT 'edge', stable_id, owner, props, stable_id FROM edges WHERE retired_rev IS NULL;
        INSERT OR IGNORE INTO entity_contributions
          SELECT ev.entity_type, ev.entity_stable, ev.resolver, '{}', ev.entity_stable FROM evidence ev
          WHERE ev.retired_rev IS NULL AND (
            (ev.entity_type = 'node' AND EXISTS (SELECT 1 FROM nodes n WHERE n.stable_id = ev.entity_stable AND n.retired_rev IS NULL)) OR
            (ev.entity_type = 'edge' AND EXISTS (SELECT 1 FROM edges e WHERE e.stable_id = ev.entity_stable AND e.retired_rev IS NULL))
          );`);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** ---------- revisions ---------- */

  beginRevision(kind: string, meta: Properties = {}): number {
    const r = this.db
      .prepare(`INSERT INTO revisions (kind, meta) VALUES (?, ?)`)
      .run(kind, JSON.stringify(meta));
    return Number(r.lastInsertRowid);
  }

  currentRevision(): number {
    const row = this.db.prepare(`SELECT MAX(rev) AS rev FROM revisions`).get();
    return Number(row?.rev ?? 0);
  }

  /** Durable mutation token, not a run ID or commit count. Read in the data's transaction. */
  currentGeneration(): number {
    return Number(this.db.prepare("SELECT generation FROM store_state WHERE id = 1").get()!.generation);
  }

  /** ---------- profile ---------- */

  activateProfile(profile: Profile, hash: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(`SELECT hash FROM profile_snapshots WHERE hash = ?`).get(hash);
      if (!existing) {
        const rev = this.beginRevision("profile-activation", { hash });
        const { __trestleProfile: _m, ...bare } = profile;
        this.db
          .prepare(`INSERT INTO profile_snapshots (hash, json, activated_rev) VALUES (?, ?, ?)`)
          .run(hash, canonicalJson(bare), rev);
        this.createIdentityIndexes(profile);
      }
      this.db.prepare("UPDATE store_state SET profile_hash = ? WHERE id = 1 AND profile_hash != ?").run(hash, hash);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.profile = profile;
    this.activeProfileHash = hash;
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
    if (this.db.prepare("SELECT profile_hash FROM store_state WHERE id = 1").get()!.profile_hash !== this.activeProfileHash) {
      throw new Error("active profile changed; reopen the store with the current profile before reading or writing typed graph data");
    }
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
    // SAFETY: this query selects the two non-null TEXT columns defined in memo_cells.
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
    return this.db.prepare(`SELECT key FROM memo_cells ORDER BY key`).all().map(
      (r) => String(r.key),
    );
  }

  deleteMemoCell(key: string): void {
    this.db.prepare(`DELETE FROM memo_cells WHERE key = ?`).run(key);
  }

  /** ---------- facts ---------- */

  /** Replace a cell's facts and optional memo state as one atomic commit. */
  replaceFactsByCell(
    cell: string,
    facts: FactInput[],
    rev: number,
    memo?: { fingerprint: string; inputs: { path: string; hash: string }[] },
  ) {
    this.db.exec("BEGIN");
    try {
      const retired = this.retireFactsByCell(cell, rev);
      for (const fact of facts) this.insertFact(fact, cell, rev);
      if (memo) this.putMemoCell(cell, memo.fingerprint, memo.inputs, rev);
      this.db.exec("COMMIT");
      return { emitted: facts.length, retired };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  insertFact(fact: FactInput, cell: string, rev: number): number {
    const profile = this.requireProfile();
    const def = profile.facts[fact.kind];
    if (!def) {
      throw new Error(
        `emit: undeclared fact kind "${fact.kind}" (declared: ${Object.keys(profile.facts).join(", ") || "none"})`,
      );
    }
    const errors = validateProps(def.props, fact.props, `fact "${fact.kind}"`);
    if (!isString(fact.sourcePath) || fact.sourcePath.length === 0) {
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
      .all(kind);
    return rows.map(rowToFact);
  }

  factCounts(): { kind: string; count: number }[] {
    // SAFETY: kind is TEXT and SQLite COUNT(*) returns a number with default integer decoding.
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
    const rows =
      kind
        ? this.db.prepare(`SELECT * FROM nodes WHERE kind = ? AND retired_rev IS NULL ORDER BY id`).all(kind)
        : this.db.prepare(`SELECT * FROM nodes WHERE retired_rev IS NULL ORDER BY id`).all();
    return rows.map(rowToNode);
  }

  liveNodeByStable(stableId: string): NodeRow | null {
    const row = this.db.prepare(`SELECT * FROM nodes WHERE stable_id = ? AND retired_rev IS NULL`).get(stableId);
    return row ? rowToNode(row) : null;
  }

  liveEdges(kind?: string): EdgeRow[] {
    const rows =
      kind
        ? this.db.prepare(`SELECT * FROM edges WHERE kind = ? AND retired_rev IS NULL ORDER BY id`).all(kind)
        : this.db.prepare(`SELECT * FROM edges WHERE retired_rev IS NULL ORDER BY id`).all();
    return rows.map(rowToEdge);
  }

  liveEvidenceFor(entityStable: string): StoredEvidence[] {
    // SAFETY: SELECT * returns the evidence DDL columns; writers use node/edge tags and serialized locators.
    return this.db
      .prepare(`SELECT * FROM evidence WHERE entity_stable = ? AND retired_rev IS NULL ORDER BY id`)
      .all(entityStable) as StoredEvidence[];
  }

  /** Current evidence only; referenced facts retain their own independent retirement state. */
  graphEvidence(entityType: "node" | "edge", stableId: string, limit = 50, afterId = 0, expectedGeneration?: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("limit must be an integer from 1 to 200");
    if (!Number.isSafeInteger(afterId) || afterId < 0) throw new Error("afterId must be a non-negative safe integer");
    if (expectedGeneration !== undefined && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)) {
      throw new Error("expectedGeneration must be a non-negative safe integer");
    }
    const table = entityType === "node" ? "nodes" : "edges";
    this.db.exec("BEGIN");
    try {
      const generation = this.currentGeneration();
      if (expectedGeneration !== undefined && generation !== expectedGeneration) {
        throw new Error("store generation changed; restart evidence pagination from afterId 0");
      }
      const revision = this.currentRevision();
      // SAFETY: selected columns are TEXT and nullable INTEGER from nodes/edges DDL.
      const entity = this.db.prepare(
        `SELECT kind, retired_rev FROM ${table} WHERE stable_id = ?
         ORDER BY retired_rev IS NULL DESC, id DESC LIMIT 1`,
      ).get(stableId) as { kind: string; retired_rev: number | null } | undefined;
      const status = !entity ? "not_found" : entity.retired_rev === null ? "live" : "retired";
      // SAFETY: SELECT * returns evidence DDL columns, filtered by the explicit entity type.
      const rows = status === "live" ? this.db.prepare(
        `SELECT * FROM evidence WHERE entity_type = ? AND entity_stable = ?
         AND retired_rev IS NULL AND id > ? ORDER BY id LIMIT ?`,
      ).all(entityType, stableId, afterId, limit + 1) as StoredEvidence[] : [];
      const truncated = rows.length > limit;
      const evidence = rows.slice(0, limit).map((row) => {
        // SAFETY: SELECT * returns the facts DDL columns, including its integer revision fields.
        const fact = row.fact_id === null ? undefined : this.db.prepare("SELECT * FROM facts WHERE id = ?")
          .get(row.fact_id) as (StoredFact & { created_rev: number; retired_rev: number | null }) | undefined;
        const locator: JsonValue = row.locator === null ? null : JSON.parse(row.locator);
        return {
          id: row.id,
          sourcePath: row.source_path,
          locator,
          resolver: row.resolver,
          resolverVersion: row.resolver_version,
          rule: row.rule,
          note: row.note,
          createdRev: row.created_rev,
          retiredRev: row.retired_rev,
          factId: row.fact_id,
          fact: fact ? { ...rowToFact(fact), createdRev: fact.created_rev, retiredRev: fact.retired_rev } : null,
        };
      });
      return {
        revision, generation, entityType, stableId, status, kind: entity?.kind ?? null,
        retiredRev: entity?.retired_rev ?? null,
        limit, afterId, evidence, truncated,
        nextAfterId: truncated ? evidence[evidence.length - 1].id : null,
      };
    } finally {
      this.db.exec("COMMIT");
    }
  }

  openClaims(kind?: string): StoredClaim[] {
    // SAFETY: both branches select the claims DDL columns, including nullable candidates/rule/retired_rev.
    return (
      kind
        ? this.db
            .prepare(`SELECT * FROM claims WHERE kind = ? AND status = 'open' AND retired_rev IS NULL ORDER BY id`)
            .all(kind)
        : this.db.prepare(`SELECT * FROM claims WHERE status = 'open' AND retired_rev IS NULL ORDER BY id`).all()
    ) as StoredClaim[];
  }

  /** ---------- node ref resolution ---------- */

  resolveNodeRef(ref: NodeRef) {
    const profile = this.requireProfile();
    let kind: string;
    let identity: NodeRow["identity"];
    if (isString(ref)) {
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
  ) {
    const rev = this.beginRevision("resolve", { resolver: resolverName, version: resolverVersion });
    const applied = { node: 0, edge: 0, alias: 0, claim: 0, evidence: 0, retired: 0 };

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const profile = this.requireProfile();
      // 1. Retire this resolver's prior contribution (evidence, claims, aliases).
      this.db.prepare("DELETE FROM entity_contributions WHERE resolver = ?").run(resolverName);
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
      // SAFETY: this query selects the two non-null stable-id TEXT columns from aliases.
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
      for (const d of directives) {
        if (d.op !== "node") continue;
        const def = profile.nodes[d.kind];
        if (!def) throw new Error(`directive: undeclared node kind "${d.kind}"`);
        const idErrors = validateIdentity(def.identity, d.identity, `node ${d.kind}`);
        const propErrors = validateProps(def.props, d.props ?? {}, `node ${d.kind}`);
        if (idErrors.length + propErrors.length > 0)
          throw new Error(`directive rejected:\n  - ${[...idErrors, ...propErrors].join("\n  - ")}`);
        const sourceStable = this.nodeStableId(d.kind, d.identity);
        const stable = canon(sourceStable);
        this.contribute("node", stable, resolverName, d.props ?? {}, sourceStable);
        this.vivify(d.kind, d.identity, stable, resolverName, rev);
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

        const props = { ...d.props, ...d.identity };
        const propErrors = validateProps(def.props, props, `edge ${d.kind}`);
        if (propErrors.length > 0) throw new Error(`directive rejected:\n  - ${propErrors.join("\n  - ")}`);
        const identity: Record<string, Scalar> = {};
        for (const field of def.identity) {
          const value = props[field];
          if (!isScalar(value)) throw new Error(`edge ${d.kind}: identity prop "${field}" must be a scalar`);
          identity[field] = value;
        }

        const stable = this.edgeStableId(d.kind, fromStable, toStable, identity);
        this.contribute("edge", stable, resolverName, props);
        this.db.prepare(`INSERT OR IGNORE INTO edges
          (kind, from_stable, to_stable, identity, stable_id, props, owner, created_rev)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          d.kind, fromStable, toStable, canonicalJson(identity), stable, canonicalJson(props), resolverName, rev,
        );
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

      // 6. Rebuild properties from surviving contributions, then collect orphans.
      applied.retired += this.reconcileEntities(rev);

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
  retireAbandonedOwners(activeOwners: string[]) {
    const activeJson = JSON.stringify(activeOwners);
    const abandoned = new Set<string>();
    for (const row of this.db.prepare(
      "SELECT DISTINCT resolver FROM entity_contributions WHERE resolver NOT IN (SELECT value FROM json_each(?))",
    ).all(activeJson)) abandoned.add(String(row.resolver));
    for (const [table, col] of [
      ["evidence", "resolver"],
      ["claims", "resolver"],
      ["aliases", "resolver"],
    ] as const) {
      // SAFETY: each selected owner/resolver column is non-null TEXT, aliased to o.
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
      this.db.prepare("DELETE FROM entity_contributions WHERE resolver IN (SELECT value FROM json_each(?))").run(ownersJson);
      for (const [table, col] of [
        ["evidence", "resolver"],
        ["claims", "resolver"],
        ["aliases", "resolver"],
      ] as const) {
        const r = this.db
          .prepare(
            `UPDATE ${table} SET retired_rev = ? WHERE retired_rev IS NULL
             AND ${col} IN (SELECT value FROM json_each(?))`,
          )
          .run(rev, ownersJson);
        retired += Number(r.changes);
      }
      retired += this.reconcileEntities(rev);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { retired, owners };
  }

  private contributions(entityType: "node" | "edge", stableId: string) {
    // SAFETY: these are non-null TEXT columns; props is written as a JSON object.
    const rows = this.db.prepare(
      "SELECT resolver, props, source_stable FROM entity_contributions WHERE entity_type = ? AND entity_stable = ? ORDER BY resolver, source_stable",
    ).all(entityType, stableId) as { resolver: string; props: string; source_stable: string }[];
    return rows.map(row => {
      const props: Properties = JSON.parse(row.props);
      return { resolver: row.resolver, props, sourceStable: row.source_stable };
    });
  }

  /** A batch unions repeated declarations; omission retracts only across batches. */
  private contribute(entityType: "node" | "edge", stableId: string, resolver: string, props: Properties, sourceStable = stableId): void {
    const prior = this.contributions(entityType, stableId).find(row => row.resolver === resolver && row.sourceStable === sourceStable);
    const merged = this.mergeContributions(entityType, stableId, [
      ...(prior ? [prior] : []), { resolver, props, sourceStable },
    ]);
    this.db.prepare(`INSERT INTO entity_contributions (entity_type, entity_stable, resolver, props, source_stable) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (entity_type, entity_stable, resolver, source_stable) DO UPDATE SET props = excluded.props`).run(
      entityType, stableId, resolver, canonicalJson(merged), sourceStable,
    );
  }

  private mergeContributions(entityType: "node" | "edge", stableId: string, rows: { resolver: string; props: Properties; sourceStable: string }[]): Properties {
    // Validate each original identity before applying canonical precedence: even
    // shadowed alias values must agree when emitted by multiple resolvers.
    const identities = new Map<string, { resolver: string; props: Properties }[]>();
    for (const row of rows) {
      const group = identities.get(row.sourceStable) ?? [];
      group.push(row);
      identities.set(row.sourceStable, group);
    }
    for (const group of identities.values()) this.mergeProperties(entityType, stableId, group);
    const canonical = entityType === "node" ? identities.get(stableId) : undefined;
    const canonicalProps = canonical ? this.mergeProperties(entityType, stableId, canonical) : {};
    return this.mergeProperties(entityType, stableId, rows.map(row => ({
      resolver: row.resolver,
      props: row.sourceStable === stableId ? row.props : Object.fromEntries(
        Object.entries(row.props).filter(([key]) => !Object.hasOwn(canonicalProps, key)),
      ),
    })));
  }

  private mergeProperties(entityType: "node" | "edge", stableId: string, rows: { resolver: string; props: Properties }[]): Properties {
    const props: Properties = {};
    const owners = new Map<string, string>();
    for (const row of rows) {
      for (const [key, value] of Object.entries(row.props)) {
        if (value === undefined) continue;
        if (owners.has(key) && canonicalJson(props[key]) !== canonicalJson(value)) {
          throw new Error(`conflicting ${entityType} property "${key}" on ${stableId}: resolvers "${owners.get(key)}" and "${row.resolver}"`);
        }
        Object.defineProperty(props, key, { value, enumerable: true, configurable: true, writable: true });
        owners.set(key, row.resolver);
      }
    }
    return props;
  }

  private reconcileEntities(rev: number): number {
    let retired = 0;
    for (const edge of this.liveEdges()) {
      const rows = this.contributions("edge", edge.stableId);
      if (rows.length === 0 && this.liveEvidenceFor(edge.stableId).length === 0) {
        this.db.prepare("UPDATE edges SET retired_rev = ? WHERE id = ?").run(rev, edge.id);
        retired++;
      } else {
        const owner = rows.some(row => row.resolver === edge.owner) ? edge.owner : rows[0]?.resolver ?? edge.owner;
        this.upsertEdge(edge.kind, edge.fromStable, edge.toStable, edge.identity, edge.stableId,
          this.mergeContributions("edge", edge.stableId, rows), owner, rev);
      }
    }
    for (const node of this.liveNodes()) {
      const rows = this.contributions("node", node.stableId);
      const referenced = this.db.prepare(
        "SELECT 1 FROM edges WHERE (from_stable = ? OR to_stable = ?) AND retired_rev IS NULL LIMIT 1",
      ).get(node.stableId, node.stableId);
      if (rows.length === 0 && !referenced && this.liveEvidenceFor(node.stableId).length === 0) {
        this.db.prepare("UPDATE nodes SET retired_rev = ? WHERE id = ?").run(rev, node.id);
        retired++;
      } else {
        const owner = rows.some(row => row.resolver === node.owner) ? node.owner : rows[0]?.resolver ?? node.owner;
        this.upsertNode(node.kind, node.identity, node.stableId,
          this.mergeContributions("node", node.stableId, rows), rows.length > 0 ? "declared" : "stub", owner, rev);
      }
    }
    return retired;
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
    props: Properties,
    provenance: "stub" | "declared",
    owner: string,
    rev: number,
  ): void {
    const existing = this.liveNodeByStable(stableId);
    if (existing) {
      const unchanged =
        existing.owner === owner && existing.provenance === provenance && canonicalJson(existing.props) === canonicalJson(props);
      if (unchanged) return;
      // update = retire + insert under the same stable_id
      this.db.prepare(`UPDATE nodes SET retired_rev = ? WHERE id = ?`).run(rev, existing.id);
      this.db
        .prepare(
          `INSERT INTO nodes (kind, identity, stable_id, props, provenance, owner, created_rev)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, canonicalJson(identity), stableId, JSON.stringify(props), provenance, owner, rev);
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
    props: Properties,
    owner: string,
    rev: number,
  ): void {
    // SAFETY: edges.id is INTEGER and props/owner are non-null TEXT; get may find no live edge.
    const existing = this.db
      .prepare(`SELECT id, props, owner FROM edges WHERE stable_id = ? AND retired_rev IS NULL`)
      .get(stableId) as { id: number; props: string; owner: string } | undefined;
    if (existing) {
      if (existing.owner === owner && canonicalJson(JSON.parse(existing.props)) === canonicalJson(props)) return;
      this.db.prepare(`UPDATE edges SET retired_rev = ? WHERE id = ?`).run(rev, existing.id);
      this.db
        .prepare(
          `INSERT INTO edges (kind, from_stable, to_stable, identity, stable_id, props, owner, created_rev)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(kind, fromStable, toStable, canonicalJson(identity), stableId, JSON.stringify(props), owner, rev);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO edges (kind, from_stable, to_stable, identity, stable_id, props, owner, created_rev)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(kind, fromStable, toStable, canonicalJson(identity), stableId, JSON.stringify(props), owner, rev);
  }

  /** Preserve alias-merge precedence while moving the surviving property owners. */
  private moveContributions(entityType: "node" | "edge", from: string, to: string, winningProps: Properties): void {
    const rows = [...this.contributions(entityType, to), ...this.contributions(entityType, from)];
    this.db.prepare("DELETE FROM entity_contributions WHERE entity_type = ? AND entity_stable IN (?, ?)").run(entityType, from, to);
    for (const row of rows) {
      const props = entityType === "node" ? row.props : Object.fromEntries(Object.entries(row.props).filter(
        ([key, value]) => canonicalJson(value) === canonicalJson(winningProps[key]),
      ));
      this.contribute(entityType, to, row.resolver, props, entityType === "node" ? row.sourceStable : to);
    }
  }

  /** Merge an alias node's observations into the canonical node (retire + re-point). */
  private mergeNodeInto(aliasStable: string, canonicalStable: string, rev: number): void {
    if (aliasStable === canonicalStable) return;
    const aliasNode = this.liveNodeByStable(aliasStable);
    if (aliasNode) {
      this.db.prepare(`UPDATE nodes SET retired_rev = ? WHERE id = ?`).run(rev, aliasNode.id);
      // Fold props into the canonical node if it exists and lacks them.
      const canonNode = this.liveNodeByStable(canonicalStable);
      this.moveContributions("node", aliasStable, canonicalStable, { ...aliasNode.props, ...canonNode?.props });
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
      .all(aliasStable, aliasStable);
    for (const raw of touching) {
      const e = rowToEdge(raw);
      this.db.prepare(`UPDATE edges SET retired_rev = ? WHERE id = ?`).run(rev, e.id);
      const fromStable = e.fromStable === aliasStable ? canonicalStable : e.fromStable;
      const toStable = e.toStable === aliasStable ? canonicalStable : e.toStable;
      const newStable = this.edgeStableId(e.kind, fromStable, toStable, e.identity);
      const target = this.db.prepare("SELECT props FROM edges WHERE stable_id = ? AND retired_rev IS NULL").get(newStable);
      const targetProps: Properties = target ? JSON.parse(String(target.props)) : {};
      const mergedProps = { ...targetProps, ...e.props };
      this.moveContributions("edge", e.stableId, newStable, mergedProps);
      this.upsertEdge(e.kind, fromStable, toStable, e.identity, newStable, mergedProps, e.owner, rev);
      // Re-point the edge's evidence (retire + reinsert keeps append-only history).
      const evRows = this.liveEvidenceFor(e.stableId);
      for (const ev of evRows) {
        this.db.prepare(`UPDATE evidence SET retired_rev = ? WHERE id = ?`).run(rev, ev.id);
        this.db
          .prepare(
            `INSERT INTO evidence (entity_type, entity_stable, fact_id, source_path, locator,
               resolver, resolver_version, rule, note, created_rev)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            ev.entity_type,
            newStable,
            ev.fact_id,
            ev.source_path,
            ev.locator,
            ev.resolver,
            ev.resolver_version,
            ev.rule,
            ev.note,
            rev,
          );
      }
    }
    // Re-point evidence attached directly to the alias node.
    const nodeEv = this.liveEvidenceFor(aliasStable);
    for (const ev of nodeEv) {
      this.db.prepare(`UPDATE evidence SET entity_stable = ? WHERE id = ?`).run(canonicalStable, ev.id);
    }
  }
}

/** ---------- row mappers ---------- */

function rowToFact(raw: Record<string, SQLOutputValue>): FactRow {
  // SAFETY: callers select the facts DDL columns; insertFact serializes props, authority and locator.
  const row = raw as StoredFact;
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    cell: row.cell,
    sourcePath: row.source_path,
    locator: row.locator ? JSON.parse(row.locator) : null,
    authority: row.authority ? JSON.parse(row.authority) : null,
    props: JSON.parse(row.props),
  };
}

function rowToNode(raw: Record<string, SQLOutputValue>): NodeRow {
  // SAFETY: callers select nodes.*; vivify/upsertNode write scalar identities and stub/declared provenance.
  const row = raw as StoredNode;
  return {
    id: row.id,
    kind: row.kind,
    identity: JSON.parse(row.identity),
    stableId: row.stable_id,
    props: JSON.parse(row.props),
    provenance: row.provenance,
    owner: row.owner,
    createdRev: row.created_rev,
  };
}

function rowToEdge(raw: Record<string, SQLOutputValue>): EdgeRow {
  // SAFETY: callers select edges.*; upsertEdge writes scalar identity JSON and non-null stable ids/props.
  const row = raw as StoredEdge;
  return {
    id: row.id,
    kind: row.kind,
    fromStable: row.from_stable,
    toStable: row.to_stable,
    identity: JSON.parse(row.identity),
    stableId: row.stable_id,
    props: JSON.parse(row.props),
    owner: row.owner,
    createdRev: row.created_rev,
  };
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_]/g, "_");
}
