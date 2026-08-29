/**
 * LadybugDB projection: a regenerable Cypher-queryable materialization of
 * the live graph (ARCHITECTURE §3.5/§7.3). The SQLite store stays the
 * system of record; this projection is derived, disposable, and rebuilt
 * wholesale by `trestle project build`.
 *
 * Mapping: one node table per node kind (stableId PK + identity fields +
 * scalar props as columns, rest as propsJson), one rel table per edge kind
 * (multi-pair FROM/TO from the profile, edge props + confidence/
 * evidenceCount derived from live evidence rows).
 *
 * @ladybugdb/core is an optional peer dependency — the engine keeps zero
 * required runtime deps; importing this module without it installed fails
 * with an actionable message.
 */
import { existsSync, rmSync } from "node:fs";
import type { Profile } from "../profile/define.ts";
import type { PropSchema } from "../profile/schema.ts";
import type { Store } from "../store/store.ts";

interface LbugModule {
  Database: new (path: string) => unknown;
  Connection: new (db: unknown) => {
    query(cypher: string): Promise<{ getAll(): Promise<Record<string, unknown>[]> }>;
  };
}

async function loadLbug(): Promise<LbugModule> {
  try {
    return (await import("@ladybugdb/core")) as unknown as LbugModule;
  } catch {
    throw new Error(
      `the LadybugDB projection requires the optional dependency @ladybugdb/core\n` +
        `  install it in your trestle project: npm install @ladybugdb/core`,
    );
  }
}

/** Cypher/Ladybug identifiers: kinds may contain "-", table names may not. */
export function tableName(kind: string): string {
  return kind.replaceAll("-", "_");
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
  const { Database, Connection } = await loadLbug();
  const profile = store.requireProfile();
  if (existsSync(dbPath)) rmSync(dbPath, { recursive: true, force: true }); // regenerable by design
  const conn = new Connection(new Database(dbPath));
  const result: ProjectionResult = { path: dbPath, nodeTables: 0, relTables: 0, nodes: 0, edges: 0 };

  // ---- DDL from the profile ----
  for (const [kind, def] of Object.entries(profile.nodes)) {
    const cols = nodeColumns(def)
      .map((c) => `${c.name} ${c.type}`)
      .join(", ");
    await conn.query(
      `CREATE NODE TABLE ${tableName(kind)}(stableId STRING, ${cols}${cols ? ", " : ""}propsJson STRING, provenance STRING, PRIMARY KEY (stableId))`,
    );
    result.nodeTables++;
  }
  for (const [kind, def] of Object.entries(profile.edges)) {
    const pairs: string[] = [];
    for (const from of def.from) for (const to of def.to) pairs.push(`FROM ${tableName(from)} TO ${tableName(to)}`);
    const cols = edgeColumns(def)
      .map((c) => `${c.name} ${c.type}, `)
      .join("");
    await conn.query(
      `CREATE REL TABLE ${tableName(kind)}(${pairs.join(", ")}, ${cols}confidence DOUBLE, evidenceCount INT64)`,
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
      await conn.query(
        `CREATE (:${tableName(kind)} {stableId: ${lit(n.stableId)}${cols.length ? ", " : ""}` +
          cols.map((c, i) => `${c.name}: ${values[i]}`).join(", ") +
          `, propsJson: ${lit(JSON.stringify(extras))}, provenance: ${lit(n.provenance)}})`,
      );
      result.nodes++;
    }
  }

  // ---- edges (confidence/evidenceCount derived from live evidence) ----
  for (const [kind, def] of Object.entries(profile.edges)) {
    const cols = edgeColumns(def);
    for (const e of store.liveEdges(kind)) {
      const fromKind = kindOfStable.get(e.fromStable);
      const toKind = kindOfStable.get(e.toStable);
      if (!fromKind || !toKind) continue; // endpoint not live; orphan cleanup owns this
      const evidence = store.liveEvidenceFor(e.stableId);
      const confidence = evidence.length ? Math.max(...evidence.map((ev) => Number(ev.confidence))) : 0;
      await conn.query(
        `MATCH (a:${tableName(fromKind)} {stableId: ${lit(e.fromStable)}}), (b:${tableName(toKind)} {stableId: ${lit(e.toStable)}}) ` +
          `CREATE (a)-[:${tableName(kind)} {` +
          cols.map((c) => `${c.name}: ${lit(e.props[c.name])}, `).join("") +
          `confidence: ${confidence}, evidenceCount: ${evidence.length}}]->(b)`,
      );
      result.edges++;
    }
  }

  return result;
}

/** Open an existing projection and run one Cypher query. */
export async function queryProjection(dbPath: string, cypher: string): Promise<Record<string, unknown>[]> {
  const { Database, Connection } = await loadLbug();
  if (!existsSync(dbPath)) {
    throw new Error(`no projection at ${dbPath}; run \`trestle project build\` first`);
  }
  const conn = new Connection(new Database(dbPath));
  const res = await conn.query(cypher);
  return res.getAll();
}
