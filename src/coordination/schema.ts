import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "../profile/canonical.ts";
import { isJsonValue, isProperties, isString, type JsonValue } from "../profile/value.ts";
import type {
  Artifact,
  Bookmark,
  MigrationUnit,
  Session,
  SessionRef,
  UnitEvent,
  UnitStatus,
} from "./types.ts";

const VERSION = 1;
const LEGACY_TABLES = [
  "migration_units",
  "migration_bookmarks",
  "migration_handoffs",
  "session_artifacts",
  "bookmark_artifacts",
] as const;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS coordination_version(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS coordination_sessions(
  key TEXT PRIMARY KEY, provider TEXT NOT NULL, session_id TEXT NOT NULL,
  data TEXT NOT NULL, unit_id TEXT
);
CREATE TABLE IF NOT EXISTS coordination_units(
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL, lead_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_observations(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, session_key TEXT NOT NULL, observed_at TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, unit_id TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_artifacts(
  id TEXT PRIMARY KEY, session_key TEXT NOT NULL, kind TEXT NOT NULL,
  data TEXT NOT NULL, search_text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_bookmarks(
  id TEXT PRIMARY KEY, unit_id TEXT NOT NULL, artifact_id TEXT, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coordination_requests(
  actor TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY(actor, request_id)
);
CREATE INDEX IF NOT EXISTS coordination_sessions_provider ON coordination_sessions(provider, session_id);
CREATE INDEX IF NOT EXISTS coordination_sessions_unit ON coordination_sessions(unit_id);
CREATE INDEX IF NOT EXISTS coordination_observations_session ON coordination_observations(session_key, seq);
CREATE INDEX IF NOT EXISTS coordination_events_unit ON coordination_events(unit_id, seq);
CREATE INDEX IF NOT EXISTS coordination_artifacts_session ON coordination_artifacts(session_key);
CREATE INDEX IF NOT EXISTS coordination_artifacts_kind ON coordination_artifacts(kind);
CREATE INDEX IF NOT EXISTS coordination_bookmarks_unit ON coordination_bookmarks(unit_id);
CREATE INDEX IF NOT EXISTS coordination_bookmarks_artifact ON coordination_bookmarks(artifact_id);
`;

type VersionRow = { version: number };
type LegacyUnitRow = {
  id: string; title: string; objective: string; acceptance: string; scope: string;
  source_revision: string; status: string; revision: number; lead_provider: string; lead_session: string;
};
type LegacyBookmarkRow = {
  id: number; unit_id: string; kind: string; locator: string; description: string;
  provider: string; session: string; created_at: string;
};
type LegacyHandoffRow = {
  id: number; unit_id: string; revision: number; previous_provider: string;
  previous_session: string; provider: string; session: string; bookmark_id: number;
};
type LegacyArtifactRow = {
  id: string; provider: string; session: string; external_id: string; kind: string;
  locator: string; metadata: string; content: string | null; captured_at: string;
};
type LegacyPinRow = { bookmark_id: number; artifact_id: string };

export function sessionKey(ref: SessionRef): string {
  return canonicalJson({ provider: ref.provider, sessionId: ref.sessionId });
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function parseJson(text: string, label: string): JsonValue {
  try {
    const value: unknown = JSON.parse(text);
    if (!isJsonValue(value)) throw new Error("invalid JSON value");
    return value;
  } catch {
    throw new Error(`cannot upgrade legacy coordination data: malformed ${label} JSON`);
  }
}

function isUnitStatus(value: string): value is UnitStatus {
  return value === "planned" || value === "active" || value === "blocked" || value === "complete";
}

function isBookmarkKind(value: string): value is Bookmark["kind"] {
  return value === "decision" || value === "verification" || value === "blocker" || value === "handoff";
}

function ref(provider: string, sessionId: string): SessionRef {
  if (!provider.trim() || !sessionId.trim()) throw new Error("cannot upgrade legacy coordination data: empty session reference");
  return { provider, sessionId };
}

function importLegacy(db: DatabaseSync): void {
  // SAFETY: this owner-specific row contract mirrors the named legacy SELECT list.
  const units = (tableExists(db, "migration_units")
    ? db.prepare("SELECT id,title,objective,acceptance,scope,source_revision,status,revision,lead_provider,lead_session FROM migration_units ORDER BY id").all()
    : []) as LegacyUnitRow[];
  // SAFETY: this owner-specific row contract mirrors the named legacy SELECT list.
  const bookmarks = (tableExists(db, "migration_bookmarks")
    ? db.prepare("SELECT id,unit_id,kind,locator,description,provider,session,created_at FROM migration_bookmarks ORDER BY id").all()
    : []) as LegacyBookmarkRow[];
  // SAFETY: this owner-specific row contract mirrors the named legacy SELECT list.
  const handoffs = (tableExists(db, "migration_handoffs")
    ? db.prepare("SELECT id,unit_id,revision,previous_provider,previous_session,provider,session,bookmark_id FROM migration_handoffs ORDER BY id").all()
    : []) as LegacyHandoffRow[];
  // SAFETY: this owner-specific row contract mirrors the named legacy SELECT list.
  const artifacts = (tableExists(db, "session_artifacts")
    ? db.prepare("SELECT id,provider,session,external_id,kind,locator,metadata,content,captured_at FROM session_artifacts ORDER BY rowid").all()
    : []) as LegacyArtifactRow[];
  // SAFETY: this owner-specific row contract mirrors the named legacy SELECT list.
  const pins = (tableExists(db, "bookmark_artifacts")
    ? db.prepare("SELECT bookmark_id,artifact_id FROM bookmark_artifacts ORDER BY bookmark_id").all()
    : []) as LegacyPinRow[];

  const unitIds = new Set(units.map((unit) => unit.id));
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  const membership = new Map<string, string>();
  const sessions = new Map<string, SessionRef>();
  const register = (session: SessionRef, unitId?: string): string => {
    const key = sessionKey(session);
    sessions.set(key, session);
    if (unitId !== undefined) {
      const owner = membership.get(key);
      if (owner !== undefined && owner !== unitId) {
        throw new Error(`cannot upgrade legacy coordination data: session ${session.provider}/${session.sessionId} is a lead of both ${owner} and ${unitId}`);
      }
      membership.set(key, unitId);
    }
    return key;
  };

  for (const unit of units) register(ref(unit.lead_provider, unit.lead_session), unit.id);
  for (const handoff of handoffs) {
    if (!unitIds.has(handoff.unit_id)) throw new Error(`cannot upgrade legacy coordination data: handoff ${handoff.id} references missing unit ${handoff.unit_id}`);
    register(ref(handoff.previous_provider, handoff.previous_session), handoff.unit_id);
    register(ref(handoff.provider, handoff.session), handoff.unit_id);
  }
  for (const artifact of artifacts) register(ref(artifact.provider, artifact.session));
  for (const bookmark of bookmarks) register(ref(bookmark.provider, bookmark.session));

  const insertSession = db.prepare("INSERT INTO coordination_sessions(key,provider,session_id,data,unit_id) VALUES (?,?,?,?,?)");
  for (const [key, sessionRef] of sessions) {
    const session: Session = { ref: sessionRef };
    insertSession.run(key, sessionRef.provider, sessionRef.sessionId, canonicalJson(session), membership.get(key) ?? null);
  }

  const importedAt = new Date().toISOString();
  const insertUnit = db.prepare("INSERT INTO coordination_units(id,revision,lead_key,data) VALUES (?,?,?,?)");
  const insertEvent = db.prepare("INSERT INTO coordination_events(unit_id,data) VALUES (?,?)");
  for (const row of units) {
    const scope = parseJson(row.scope, `scope for unit ${row.id}`);
    if (!Array.isArray(scope) || !scope.every(isString) || !isUnitStatus(row.status) ||
        !Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new Error(`cannot upgrade legacy coordination data: invalid unit ${row.id}`);
    }
    const unit: MigrationUnit = {
      id: row.id, title: row.title, objective: row.objective, acceptance: row.acceptance,
      scope: { graphRevision: null, entityIds: scope, sourceRevision: row.source_revision },
      lead: ref(row.lead_provider, row.lead_session), status: row.status, revision: row.revision,
    };
    insertUnit.run(unit.id, unit.revision, sessionKey(unit.lead), canonicalJson(unit));
    const event: UnitEvent = {
      id: `legacy-import-${row.id}`, unitId: row.id, revision: row.revision, actor: "legacy-import",
      recordedAt: importedAt, kind: "imported", reason: "Imported legacy unit; earlier status history was not recorded",
      details: { historicalStatusHistory: "unavailable" },
    };
    insertEvent.run(row.id, canonicalJson(event));
  }

  for (const row of handoffs) {
    const event: UnitEvent = {
      id: `legacy-handoff-${row.id}`, unitId: row.unit_id, revision: row.revision,
      actor: "legacy-import", recordedAt: importedAt, kind: "handoff",
      reason: "Imported legacy handoff; historical timestamp was not recorded",
      details: {
        previousLead: ref(row.previous_provider, row.previous_session),
        lead: ref(row.provider, row.session), bookmarkId: String(row.bookmark_id),
      },
    };
    insertEvent.run(row.unit_id, canonicalJson(event));
  }

  const insertArtifact = db.prepare("INSERT INTO coordination_artifacts(id,session_key,kind,data,search_text) VALUES (?,?,?,?,?)");
  for (const row of artifacts) {
    const metadata = parseJson(row.metadata, `metadata for artifact ${row.id}`);
    if (!isProperties(metadata)) throw new Error(`cannot upgrade legacy coordination data: invalid metadata for artifact ${row.id}`);
    const artifact: Artifact = {
      id: row.id, session: ref(row.provider, row.session), nativeId: row.external_id,
      kind: row.kind, locator: row.locator, metadata, capturedAt: row.captured_at,
    };
    if (row.content !== null) artifact.text = row.content;
    insertArtifact.run(row.id, sessionKey(artifact.session), row.kind, canonicalJson(artifact),
      [row.kind, row.locator, row.metadata, row.content ?? ""].join("\n"));
  }

  const pinByBookmark = new Map<number, string>();
  for (const pin of pins) {
    if (pinByBookmark.has(pin.bookmark_id)) throw new Error(`cannot upgrade legacy coordination data: duplicate pin for bookmark ${pin.bookmark_id}`);
    if (!artifactIds.has(pin.artifact_id)) throw new Error(`cannot upgrade legacy coordination data: bookmark ${pin.bookmark_id} pins missing artifact ${pin.artifact_id}`);
    pinByBookmark.set(pin.bookmark_id, pin.artifact_id);
  }
  const bookmarkIds = new Set(bookmarks.map((bookmark) => bookmark.id));
  for (const pin of pins) if (!bookmarkIds.has(pin.bookmark_id)) throw new Error(`cannot upgrade legacy coordination data: pin references missing bookmark ${pin.bookmark_id}`);
  const insertBookmark = db.prepare("INSERT INTO coordination_bookmarks(id,unit_id,artifact_id,data) VALUES (?,?,?,?)");
  for (const row of bookmarks) {
    if (!unitIds.has(row.unit_id)) throw new Error(`cannot upgrade legacy coordination data: bookmark ${row.id} references missing unit ${row.unit_id}`);
    if (!isBookmarkKind(row.kind)) throw new Error(`cannot upgrade legacy coordination data: invalid bookmark ${row.id}`);
    const artifactId = pinByBookmark.get(row.id) ?? null;
    const bookmark: Bookmark = {
      id: String(row.id), unitId: row.unit_id, artifactId,
      kind: row.kind, description: row.description, createdAt: row.created_at,
    };
    if (artifactId === null) bookmark.legacyLocator = { provider: row.provider, sessionId: row.session, locator: row.locator };
    insertBookmark.run(bookmark.id, bookmark.unitId, artifactId, canonicalJson(bookmark));
  }
}

/** Creates the coordination store or atomically upgrades the legacy coordination tables. */
export function initializeCoordination(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (tableExists(db, "coordination_version")) {
      // SAFETY: this named column is read from the coordination_version table we own.
      const rows = db.prepare("SELECT version FROM coordination_version").all() as VersionRow[];
      if (rows.length !== 1 || rows[0]?.version !== VERSION) {
        const found = rows.length === 1 ? rows[0]?.version : `${rows.length} rows`;
        throw new Error(`unsupported coordination schema version ${String(found)}; this build supports version ${VERSION}`);
      }
      db.exec(SCHEMA);
      db.exec("COMMIT");
      return;
    }
    db.exec(SCHEMA);
    importLegacy(db);
    db.prepare("INSERT INTO coordination_version(version) VALUES (?)").run(VERSION);
    for (const table of LEGACY_TABLES) if (tableExists(db, table)) db.exec(`DROP TABLE ${table}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
