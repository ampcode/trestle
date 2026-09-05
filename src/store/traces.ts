import type { Store } from "./store.ts";
import { canonicalJson, sha256 } from "../profile/canonical.ts";
import { isProperties } from "../profile/value.ts";

export function initTraces(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS session_artifacts (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, session TEXT NOT NULL,
      external_id TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL,
      metadata TEXT NOT NULL, content TEXT, content_hash TEXT NOT NULL,
      captured_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS session_artifacts_session ON session_artifacts(provider, session);
    CREATE TABLE IF NOT EXISTS bookmark_artifacts (
      bookmark_id INTEGER PRIMARY KEY, artifact_id TEXT NOT NULL
    );
  `);
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export function getArtifact(store: Store, id: unknown): Record<string, unknown> {
  if (typeof id !== "string") throw new Error("artifactId must be a string");
  const row = store.db.prepare("SELECT * FROM session_artifacts WHERE id = ?").get(id);
  if (!row) throw new Error(`unknown artifact: ${id}`);
  return { ...row, metadata: JSON.parse(String(row.metadata)) };
}

/** Immutable, content-addressed snapshots; provider adapters supply approved content only. */
export function traces(store: Store, args: Record<string, unknown>): unknown {
  initTraces(store);
  if (args.operation === "artifact-get") return getArtifact(store, args.artifactId);
  if (args.operation === "artifact-import") {
    const provider = text(args, "provider"), session = text(args, "session");
    if (!Array.isArray(args.artifacts) || args.artifacts.length === 0 || args.artifacts.length > 20) {
      throw new Error("artifacts must contain 1–20 records");
    }
    // Validate the entire batch before writing any records.
    const records = args.artifacts.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact must be an object");
      const item = value as Record<string, unknown>;
      const externalId = text(item, "externalId"), kind = text(item, "kind"), locator = text(item, "locator");
      const metadata = item.metadata ?? {};
      if (!isProperties(metadata)) throw new Error("metadata must be an object");
      if (item.content !== undefined && typeof item.content !== "string") throw new Error("content must be a string");
      const content = item.content === undefined ? null : item.content as string;
      const metadataJson = canonicalJson(metadata);
      const hash = sha256(canonicalJson({ metadata, content, kind, locator }));
      const id = sha256(canonicalJson({ provider, session, externalId, hash }));
      return { id, externalId, kind, locator, metadataJson, content, hash };
    });
    store.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = store.db.prepare(`INSERT INTO session_artifacts
        (id,provider,session,external_id,kind,locator,metadata,content,content_hash)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`);
      for (const r of records) insert.run(r.id, provider, session, r.externalId, r.kind, r.locator, r.metadataJson, r.content, r.hash);
      store.db.exec("COMMIT");
      return records.map(r => ({ id: r.id, externalId: r.externalId, contentHash: r.hash }));
    } catch (error) { store.db.exec("ROLLBACK"); throw error; }
  }
  if (args.operation !== "artifact-search") throw new Error("unknown artifact operation");
  const offset = args.offset ?? 0;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid offset");
  const filters: string[] = [], values: string[] = [];
  for (const key of ["provider", "session", "kind"] as const) {
    if (args[key] !== undefined) { filters.push(`${key} = ?`); values.push(text(args, key)); }
  }
  if (args.query !== undefined) {
    filters.push("(instr(lower(coalesce(content,'')), lower(?)) > 0 OR instr(lower(metadata), lower(?)) > 0)");
    const query = text(args, "query"); values.push(query, query);
  }
  const rows = store.db.prepare(`SELECT id,provider,session,external_id,kind,locator,metadata,content_hash,captured_at,
    content IS NOT NULL AS content_captured FROM session_artifacts
    ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY rowid LIMIT 21 OFFSET ?`).all(...values, offset);
  return { artifacts: rows.slice(0, 20).map(row => ({ ...row, metadata: JSON.parse(String(row.metadata)) })),
    nextOffset: rows.length > 20 ? offset + 20 : null };
}
