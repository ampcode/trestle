import type { Store } from "./store.ts";
import { getArtifact, initTraces, traces } from "./traces.ts";

// Coordination records are not resolver output: graph retirement never touches them.
const DDL = `
CREATE TABLE IF NOT EXISTS migration_units (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance TEXT NOT NULL,
  scope TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','blocked','complete')),
  revision INTEGER NOT NULL DEFAULT 1,
  lead_provider TEXT NOT NULL CHECK(length(trim(lead_provider)) > 0),
  lead_session TEXT NOT NULL CHECK(length(trim(lead_session)) > 0),
  UNIQUE(lead_provider, lead_session)
);
CREATE TABLE IF NOT EXISTS migration_bookmarks (
  id INTEGER PRIMARY KEY,
  unit_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  locator TEXT NOT NULL,
  description TEXT NOT NULL,
  provider TEXT NOT NULL,
  session TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS migration_handoffs (
  id INTEGER PRIMARY KEY,
  unit_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  previous_provider TEXT NOT NULL,
  previous_session TEXT NOT NULL,
  provider TEXT NOT NULL,
  session TEXT NOT NULL,
  bookmark_id INTEGER NOT NULL
);
`;

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} must be a non-empty string`);
  return value.trim();
}

export const migrationSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: ["create", "list", "get", "status", "handoff", "bookmark", "bookmark-get", "artifact-import", "artifact-search", "artifact-get"] },
    artifactId: { type: "string", description: "Immutable indexed artifact ID; bookmark uses its provider/session/locator." },
    bookmarkId: { type: "integer", minimum: 1 },
    query: { type: "string", description: "Literal case-insensitive substring of captured content or metadata." },
    offset: { type: "integer", minimum: 0 },
    artifacts: { type: "array", minItems: 1, maxItems: 20, items: {
      type: "object", properties: {
        externalId: { type: "string" }, kind: { type: "string" }, locator: { type: "string" },
        metadata: { type: "object" }, content: { type: "string", description: "Optional approved content to retain. Omit for metadata-only indexing." },
      }, required: ["externalId", "kind", "locator"],
    } },
    id: { type: "string", description: "Migration unit ID." },
    title: { type: "string" }, objective: { type: "string" }, acceptance: { type: "string" },
    scope: { type: "array", items: { type: "string" }, description: "Frozen graph entity stable IDs." },
    sourceRevision: { type: "string", description: "Pinned source commit or revision manifest reference." },
    provider: { type: "string", description: "Harness identifier, e.g. amp or codex." },
    session: { type: "string", description: "Existing native session ID; no session is spawned." },
    revision: { type: "integer", minimum: 1, description: "Expected unit revision for status or handoff." },
    status: { type: "string", enum: ["planned", "active", "blocked", "complete"] },
    kind: { type: "string", description: "Bookmark: decision, verification, blocker or handoff. Artifact search: provider-neutral artifact kind." },
    locator: { type: "string", description: "Native message URL, commit URL, or retained artifact reference." },
    description: { type: "string" },
  },
  required: ["operation"],
};

/** Shared CLI/MCP boundary; all mutations validate before committing. */
export function migration(store: Store, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("migration expects an object");
  const args = input as Record<string, unknown>;
  const op = text(args, "operation");
  const db = store.db;
  db.exec(DDL);
  initTraces(store);
  if (op.startsWith("artifact-")) return traces(store, args);
  if (op === "bookmark-get") {
    if (!Number.isSafeInteger(args.bookmarkId)) throw new Error("bookmarkId must be an integer");
    const bookmark = db.prepare(`SELECT b.*, a.artifact_id FROM migration_bookmarks b
      LEFT JOIN bookmark_artifacts a ON a.bookmark_id = b.id WHERE b.id = ?`).get(args.bookmarkId as number);
    if (!bookmark) throw new Error("unknown bookmark");
    return { ...bookmark, artifact: bookmark.artifact_id ? getArtifact(store, bookmark.artifact_id) : null };
  }
  if (op === "list") return db.prepare("SELECT * FROM migration_units ORDER BY id").all().map(decode);
  const id = text(args, "id");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (op === "create") {
      if (!Array.isArray(args.scope) || !args.scope.every(s => typeof s === "string" && s.trim())) {
        throw new Error("scope must be an array of graph entity stable IDs");
      }
      db.prepare(`INSERT INTO migration_units
        (id,title,objective,acceptance,scope,source_revision,lead_provider,lead_session)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, text(args, "title"), text(args, "objective"), text(args, "acceptance"),
          JSON.stringify([...new Set(args.scope)]), text(args, "sourceRevision"), text(args, "provider"), text(args, "session"));
    } else {
      const unit = db.prepare("SELECT * FROM migration_units WHERE id = ?").get(id);
      if (!unit) throw new Error(`unknown migration unit: ${id}`);
      if (op === "status" || op === "handoff") {
        if (!Number.isSafeInteger(args.revision) || args.revision !== unit.revision) throw new Error("stale or missing unit revision");
      }
      if (op === "status") {
        const status = text(args, "status");
        if (!["planned", "active", "blocked", "complete"].includes(status)) throw new Error("invalid migration status");
        db.prepare("UPDATE migration_units SET status = ?, revision = revision + 1 WHERE id = ?").run(status, id);
      } else if (op === "handoff" || op === "bookmark") {
        const artifact = args.artifactId === undefined ? null : getArtifact(store, args.artifactId);
        const provider = artifact ? String(artifact.provider) : text(args, "provider");
        const session = artifact ? String(artifact.session) : text(args, "session");
        if (artifact && ((args.provider !== undefined && args.provider !== provider) ||
          (args.session !== undefined && args.session !== session))) throw new Error("artifact session does not match");
        const kind = op === "handoff" ? "handoff" : text(args, "kind");
        if (!["decision", "verification", "blocker", "handoff"].includes(kind)) throw new Error("invalid bookmark kind");
        const bookmark = db.prepare(`INSERT INTO migration_bookmarks
          (unit_id,kind,locator,description,provider,session) VALUES (?,?,?,?,?,?)`)
          .run(id, kind, artifact ? String(artifact.locator) : text(args, "locator"), text(args, "description"), provider, session);
        if (artifact) db.prepare("INSERT INTO bookmark_artifacts(bookmark_id,artifact_id) VALUES (?,?)")
          .run(bookmark.lastInsertRowid, String(artifact.id));
        if (op === "handoff") {
          if (provider === unit.lead_provider && session === unit.lead_session) throw new Error("replacement lead must differ");
          db.prepare(`UPDATE migration_units SET lead_provider = ?, lead_session = ?, revision = revision + 1 WHERE id = ?`)
            .run(provider, session, id);
          db.prepare(`INSERT INTO migration_handoffs
            (unit_id,revision,previous_provider,previous_session,provider,session,bookmark_id) VALUES (?,?,?,?,?,?,?)`)
            .run(id, Number(unit.revision) + 1, unit.lead_provider!, unit.lead_session!, provider, session, bookmark.lastInsertRowid);
        }
      } else if (op !== "get") throw new Error(`unknown migration operation: ${op}`);
    }
    const unit = db.prepare("SELECT * FROM migration_units WHERE id = ?").get(id)!;
    const result = {
      ...decode(unit),
      bookmarks: db.prepare(`SELECT b.*, a.artifact_id FROM migration_bookmarks b
        LEFT JOIN bookmark_artifacts a ON a.bookmark_id = b.id WHERE b.unit_id = ? ORDER BY b.id`).all(id),
      handoffs: db.prepare("SELECT * FROM migration_handoffs WHERE unit_id = ? ORDER BY id").all(id),
    };
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function decode(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row, scope: JSON.parse(String(row.scope)) };
}
