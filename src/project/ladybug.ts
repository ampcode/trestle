/**
 * LadybugDB projection: a regenerable Cypher-queryable materialization of
 * the live graph. The SQLite store stays the
 * system of record; this projection is derived, disposable, and rebuilt
 * wholesale by `trestle project build`.
 *
 * Mapping: one node table per node kind (stableId PK + identity fields +
 * scalar props as columns, rest as propsJson), one rel table per edge kind
 * (multi-pair FROM/TO from the profile, stableId + edge props + evidenceCount
 * derived from live evidence rows).
 *
 * @ladybugdb/core is loaded lazily so the rest of the CLI never pays for
 * its native module.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Connection, Database, LbugValue } from "@ladybugdb/core";
import type { Profile } from "../profile/define.ts";
import type { PropSchema } from "../profile/schema.ts";
import { isNumber, isProperties, isString, type JsonValue } from "../profile/value.ts";
import type { Store } from "../store/store.ts";

type LbugModule = Pick<typeof import("@ladybugdb/core"), "Database" | "Connection">;

async function loadLbug(): Promise<LbugModule> {
  try {
    return await import("@ladybugdb/core");
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
  conn: Connection;
  db: Database;
}

async function closeHandle(handle: Handle): Promise<void> {
  try {
    await handle.conn.close();
  } finally {
    await handle.db.close();
  }
}

/** Run a statement and discard the result, closing it deterministically. */
async function exec(handle: Handle, cypher: string): Promise<void> {
  const res = await handle.conn.query(cypher);
  for (const result of Array.isArray(res) ? res : [res]) result.close();
}

/** Run a query and return all rows, closing the result deterministically. */
async function all(handle: Handle, cypher: string): Promise<Record<string, LbugValue>[]> {
  const res = await handle.conn.query(cypher);
  const results = Array.isArray(res) ? res : [res];
  try {
    if (results.length !== 1) throw new Error("projection queries must contain one statement");
    return await results[0]!.getAll();
  } finally {
    for (const result of results) result.close();
  }
}

function isLockError(err: unknown): err is Error {
  return err instanceof Error && err.message.includes("Could not set lock");
}

/**
 * Read-only databases share locks. Retry legacy projections held by a writer;
 * newly built generations are closed before publication and never written again.
 */
async function connect(lbug: LbugModule, dbPath: string, readOnly: boolean, timeoutMs = 10_000): Promise<Handle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let db: Handle["db"] | null = null;
    let conn: Handle["conn"] | null = null;
    try {
      db = new lbug.Database(dbPath, 0, true, readOnly);
      await db.init();
      conn = new lbug.Connection(db);
      const handle: Handle = { conn, db };
      await exec(handle, "RETURN 1"); // the file lock is taken lazily; force it now
      return handle;
    } catch (err) {
      try {
        if (conn) await conn.close();
      } finally {
        if (db) await db.close();
      }
      if (!isLockError(err)) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `projection database at ${dbPath} is locked by another process ` +
            `(a writer holds an exclusive lock; retried for ${Math.round(timeoutMs / 1000)}s)\n` +
            `  wait for the other process to finish`,
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

function lit(value: JsonValue): string {
  if (value === null || value === undefined) return "NULL";
  if (isNumber(value)) return Number.isFinite(value) ? String(value) : "NULL";
  if (value === true || value === false) return value ? "true" : "false";
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export interface ProjectionResult {
  path: string;
  sourceGeneration: number;
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
  mkdirSync(dirname(dbPath), { recursive: true });
  // Cross-process builder exclusion, held from snapshot through publication.
  // Never steal a lock: after a crashed builder it must be removed offline.
  const lock = `${dbPath}.build-lock`;
  try {
    mkdirSync(lock);
  } catch (error) {
    if (existsSync(lock)) throw new Error(`projection build locked at ${lock}; wait for the builder, or remove the lock after confirming it has stopped`);
    throw error;
  }
  try {
    const snapshot = projectionSnapshot(store);
    const directory = mkdtempSync(`${dbPath}.generation-`);
    const generationPath = join(directory, "data.lbug");
    const manifest = join(directory, "manifest.json");
    // Retain failed generations too: a failed native close may still hold a lock.
    const result = await materialize(lbug, snapshot, generationPath);
    // A successful close alone is insufficient: verify clean read-only reopen.
    const reader = await connect(lbug, generationPath, true);
    await closeHandle(reader);
    writeFileSync(manifest, JSON.stringify({ directory: basename(directory), sourceGeneration: snapshot.sourceGeneration }));
    // Only the small pointer is renamed, never an open Ladybug database.
    renameSync(manifest, `${dbPath}.current.json`);
    return { ...result, path: dbPath };
  } finally {
    rmSync(lock, { recursive: true });
  }
}

/** No awaits while the SQLite read transaction is open on the caller's Store. */
function projectionSnapshot(store: Store) {
  store.db.exec("BEGIN");
  try {
    const sourceGeneration = store.currentGeneration();
    const profile = structuredClone(store.requireProfile());
    const nodes = store.liveNodes();
    const edges = store.liveEdges().map((edge) => ({ ...edge, evidenceCount: store.liveEvidenceFor(edge.stableId).length }));
    store.db.exec("COMMIT");
    return { sourceGeneration, profile, nodes, edges };
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

async function materialize(lbug: LbugModule, snapshot: ReturnType<typeof projectionSnapshot>, dbPath: string): Promise<ProjectionResult> {
  const { profile, sourceGeneration } = snapshot;
  const handle = await connect(lbug, dbPath, false);
  const result: ProjectionResult = { path: dbPath, sourceGeneration, nodeTables: 0, relTables: 0, nodes: 0, edges: 0 };

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
        `CREATE REL TABLE ${ident(tableName(kind))}(${pairs.join(", ")}, stableId STRING, ${cols}evidenceCount INT64)`,
      );
      result.relTables++;
    }

    // ---- nodes ----
    const kindOfStable = new Map<string, string>();
    for (const [kind, def] of Object.entries(profile.nodes)) {
      const cols = nodeColumns(def);
      for (const n of snapshot.nodes.filter((node) => node.kind === kind)) {
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
      for (const e of snapshot.edges.filter((edge) => edge.kind === kind)) {
        const fromKind = kindOfStable.get(e.fromStable);
        const toKind = kindOfStable.get(e.toStable);
        if (!fromKind || !toKind) continue; // endpoint not live; orphan cleanup owns this
        await exec(
          handle,
          `MATCH (a:${ident(tableName(fromKind))} {stableId: ${lit(e.fromStable)}}), (b:${ident(tableName(toKind))} {stableId: ${lit(e.toStable)}}) ` +
            `CREATE (a)-[:${ident(tableName(kind))} {stableId: ${lit(e.stableId)}, ` +
            cols.map((c) => `${ident(c.name)}: ${lit(e.props[c.name])}, `).join("") +
            `evidenceCount: ${e.evidenceCount}}]->(b)`,
        );
        result.edges++;
      }
    }
    await exec(handle, "CHECKPOINT");
  } finally {
    await closeHandle(handle);
  }

  return result;
}

/** Open an existing projection and run one Cypher query. */
export async function queryProjection(dbPath: string, cypher: string): Promise<Record<string, LbugValue>[]> {
  return (await queryProjectionWithMetadata(dbPath, cypher)).rows;
}

/** Metadata and rows always refer to the same immutable published generation. */
export async function queryProjectionWithMetadata(dbPath: string, cypher: string): Promise<{
  rows: Record<string, LbugValue>[];
  sourceGeneration: number | null;
}> {
  const lbug = await loadLbug();
  const pointer = `${dbPath}.current.json`;
  let generationPath = dbPath;
  let sourceGeneration: number | null = null;
  if (existsSync(pointer)) {
    const manifest: JsonValue = JSON.parse(readFileSync(pointer, "utf8"));
    if (!isProperties(manifest) || !isString(manifest.directory) ||
        basename(manifest.directory) !== manifest.directory ||
        !manifest.directory.startsWith(`${basename(dbPath)}.generation-`) ||
        !isNumber(manifest.sourceGeneration) || !Number.isSafeInteger(manifest.sourceGeneration) || manifest.sourceGeneration < 0) {
      throw new Error(`invalid projection manifest at ${pointer}; rebuild the projection`);
    }
    generationPath = join(dirname(dbPath), manifest.directory, "data.lbug");
    sourceGeneration = manifest.sourceGeneration;
  }
  if (!existsSync(generationPath)) {
    throw new Error(`no projection at ${dbPath}; run \`trestle project build\` first`);
  }
  const handle = await connect(lbug, generationPath, true);
  try {
    return { rows: await all(handle, cypher), sourceGeneration };
  } finally {
    await closeHandle(handle);
  }
}
