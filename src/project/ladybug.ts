/**
 * LadybugDB projection: a regenerable Cypher-queryable materialization of
 * the live graph. The SQLite store stays the
 * system of record; this projection is derived, disposable, and rebuilt
 * wholesale by `trestle project build`.
 *
 * Mapping: one node table per node kind (stableId PK + identity fields +
 * scalar props as columns, rest as propsJson), one rel table per edge kind
 * (multi-pair FROM/TO from the profile, edge props + evidenceCount
 * derived from live evidence rows).
 *
 * @ladybugdb/core is loaded lazily so the rest of the CLI never pays for
 * its native module.
 */
import { existsSync, rmSync } from "node:fs";
import type { Profile } from "../profile/define.ts";
import type { PropSchema } from "../profile/schema.ts";
import type { Store } from "../store/store.ts";

interface LbugQueryResult {
  getAll(): Promise<Record<string, unknown>[]>;
  close(): void;
}

interface LbugModule {
  Database: new (path: string) => { close(): Promise<void> };
  Connection: new (db: unknown) => {
    query(cypher: string): Promise<LbugQueryResult>;
    close(): Promise<void>;
  };
}

async function loadLbug(): Promise<LbugModule> {
  try {
    return (await import("@ladybugdb/core")) as unknown as LbugModule;
  } catch {
    throw new Error(`the Cypher projection needs @ladybugdb/core; run \`npm install\` at the repo root`);
  }
}

/** Cypher/Ladybug identifiers: kinds may contain "-", table names may not. */
export function tableName(kind: string): string {
  return kind.replaceAll("-", "_");
}

/**
 * Backtick-quote an identifier for DDL/Cypher. Kind and property names come
 * from user profiles and may collide with reserved words (GROUP, TABLE, ...);
 * quoting makes the vocabulary safe instead of forcing renames.
 */
function ident(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

/**
 * An open projection handle. LadybugDB requires deterministic teardown:
 * leaked query results/connections/databases keep the file lock and a
 * `.shadow` database-ID alive, causing intermittent mismatch failures on
 * the next open.
 */
interface Handle {
  conn: InstanceType<LbugModule["Connection"]>;
  db: InstanceType<LbugModule["Database"]>;
}

async function closeHandle(handle: Handle): Promise<void> {
  try {
    await handle.conn.close();
  } catch {
    // closing is best-effort; the database close below still runs
  }
  try {
    await handle.db.close();
  } catch {
    // ignore
  }
}

/** Run a statement and discard the result, closing it deterministically. */
async function exec(handle: Handle, cypher: string): Promise<void> {
  const res = await handle.conn.query(cypher);
  res.close();
}

/** Run a query and return all rows, closing the result deterministically. */
async function all(handle: Handle, cypher: string): Promise<Record<string, unknown>[]> {
  const res = await handle.conn.query(cypher);
  try {
    return await res.getAll();
  } finally {
    res.close();
  }
}

function isLockError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("Could not set lock");
}

/**
 * LadybugDB allows a single process per database. Concurrent `project query`
 * invocations (common when agents fan out) would otherwise fail immediately
 * with a lock error, so retry with backoff for a bounded window.
 */
async function connect(lbug: LbugModule, dbPath: string, timeoutMs = 10_000): Promise<Handle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let db: Handle["db"] | null = null;
    try {
      db = new lbug.Database(dbPath);
      const conn = new lbug.Connection(db);
      const handle: Handle = { conn, db };
      await exec(handle, "RETURN 1"); // the file lock is taken lazily; force it now
      return handle;
    } catch (err) {
      if (db) {
        try {
          await db.close();
        } catch {
          // ignore
        }
      }
      if (!isLockError(err)) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `projection database at ${dbPath} is locked by another process ` +
            `(LadybugDB allows one process at a time; retried for ${Math.round(timeoutMs / 1000)}s)\n` +
            `  run project queries sequentially, or wait for the other process to finish`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function columnType(schema: PropSchema): string | null {
  switch (schema.t) {
    case "string":
    case "enum":
      return "STRING";
    case "number":
      return "DOUBLE";
    case "boolean":
      return "BOOLEAN";
    default:
      return null; // array/json → folded into propsJson
  }
}

function lit(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface ProjectionResult {
  path: string;
  nodeTables: number;
  relTables: number;
  nodes: number;
  edges: number;
}

/** Column plan for one node kind: identity fields first, then scalar props. */
function nodeColumns(def: Profile["nodes"][string]): { name: string; type: string; fromProps: boolean }[] {
  const cols: { name: string; type: string; fromProps: boolean }[] = [];
  for (const field of def.identity) cols.push({ name: field, type: "STRING", fromProps: false });
  for (const [name, schema] of Object.entries(def.props)) {
    if (def.identity.includes(name)) continue;
    const type = columnType(schema);
    if (type) cols.push({ name, type, fromProps: true });
  }
  return cols;
}

function edgeColumns(def: Profile["edges"][string]): { name: string; type: string }[] {
  const cols: { name: string; type: string }[] = [];
  for (const [name, schema] of Object.entries(def.props)) {
    const type = columnType(schema);
    if (type) cols.push({ name, type });
  }
  return cols;
}

export async function buildProjection(store: Store, dbPath: string): Promise<ProjectionResult> {
  const lbug = await loadLbug();
  const profile = store.requireProfile();
  // Regenerable by design — remove the database and its WAL/temp siblings;
  // a stale .wal/.shadow from a prior database ID makes the fresh one
  // refuse to open.
  for (const p of [dbPath, `${dbPath}.wal`, `${dbPath}.shm`, `${dbPath}.shadow`]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }
  const handle = await connect(lbug, dbPath);
  const result: ProjectionResult = { path: dbPath, nodeTables: 0, relTables: 0, nodes: 0, edges: 0 };

  try {
    // ---- DDL from the profile ----
    for (const [kind, def] of Object.entries(profile.nodes)) {
      const cols = nodeColumns(def)
        .map((c) => `${ident(c.name)} ${c.type}`)
        .join(", ");
      await exec(
        handle,
        `CREATE NODE TABLE ${ident(tableName(kind))}(stableId STRING, ${cols}${cols ? ", " : ""}propsJson STRING, provenance STRING, PRIMARY KEY (stableId))`,
      );
      result.nodeTables++;
    }
    for (const [kind, def] of Object.entries(profile.edges)) {
      const pairs: string[] = [];
      for (const from of def.from)
        for (const to of def.to) pairs.push(`FROM ${ident(tableName(from))} TO ${ident(tableName(to))}`);
      const cols = edgeColumns(def)
        .map((c) => `${ident(c.name)} ${c.type}, `)
        .join("");
      await exec(
        handle,
        `CREATE REL TABLE ${ident(tableName(kind))}(${pairs.join(", ")}, ${cols}evidenceCount INT64)`,
      );
      result.relTables++;
    }

    // ---- nodes ----
    const kindOfStable = new Map<string, string>();
    for (const [kind, def] of Object.entries(profile.nodes)) {
      const cols = nodeColumns(def);
      for (const n of store.liveNodes(kind)) {
        kindOfStable.set(n.stableId, kind);
        const values = cols.map((c) => lit(c.fromProps ? n.props[c.name] : n.identity[c.name]));
        const extras = Object.fromEntries(
          Object.entries(n.props).filter(([p]) => !cols.some((c) => c.fromProps && c.name === p)),
        );
        await exec(
          handle,
          `CREATE (:${ident(tableName(kind))} {stableId: ${lit(n.stableId)}${cols.length ? ", " : ""}` +
            cols.map((c, i) => `${ident(c.name)}: ${values[i]}`).join(", ") +
            `, propsJson: ${lit(JSON.stringify(extras))}, provenance: ${lit(n.provenance)}})`,
        );
        result.nodes++;
      }
    }

    // ---- edges (evidenceCount derived from live evidence) ----
    for (const [kind, def] of Object.entries(profile.edges)) {
      const cols = edgeColumns(def);
      for (const e of store.liveEdges(kind)) {
        const fromKind = kindOfStable.get(e.fromStable);
        const toKind = kindOfStable.get(e.toStable);
        if (!fromKind || !toKind) continue; // endpoint not live; orphan cleanup owns this
        const evidence = store.liveEvidenceFor(e.stableId);
        await exec(
          handle,
          `MATCH (a:${ident(tableName(fromKind))} {stableId: ${lit(e.fromStable)}}), (b:${ident(tableName(toKind))} {stableId: ${lit(e.toStable)}}) ` +
            `CREATE (a)-[:${ident(tableName(kind))} {` +
            cols.map((c) => `${ident(c.name)}: ${lit(e.props[c.name])}, `).join("") +
            `evidenceCount: ${evidence.length}}]->(b)`,
        );
        result.edges++;
      }
    }
  } finally {
    await closeHandle(handle);
  }

  return result;
}

/** Open an existing projection and run one Cypher query. */
export async function queryProjection(dbPath: string, cypher: string): Promise<Record<string, unknown>[]> {
  const lbug = await loadLbug();
  if (!existsSync(dbPath)) {
    throw new Error(`no projection at ${dbPath}; run \`trestle project build\` first`);
  }
  const handle = await connect(lbug, dbPath);
  try {
    return await all(handle, cypher);
  } finally {
    await closeHandle(handle);
  }
}
