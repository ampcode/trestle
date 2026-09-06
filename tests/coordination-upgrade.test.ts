import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { initializeCoordination, sessionKey } from "../src/coordination/schema.ts";
import type { Artifact, Bookmark, MigrationUnit, SessionRef, UnitEvent } from "../src/coordination/types.ts";

const LEGACY_DDL = `
CREATE TABLE migration_units(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL, acceptance TEXT NOT NULL,
  scope TEXT NOT NULL, source_revision TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
  lead_provider TEXT NOT NULL, lead_session TEXT NOT NULL
);
CREATE TABLE migration_bookmarks(
  id INTEGER PRIMARY KEY, unit_id TEXT NOT NULL, kind TEXT NOT NULL, locator TEXT NOT NULL,
  description TEXT NOT NULL, provider TEXT NOT NULL, session TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE migration_handoffs(
  id INTEGER PRIMARY KEY, unit_id TEXT NOT NULL, revision INTEGER NOT NULL,
  previous_provider TEXT NOT NULL, previous_session TEXT NOT NULL,
  provider TEXT NOT NULL, session TEXT NOT NULL, bookmark_id INTEGER NOT NULL
);
CREATE TABLE session_artifacts(
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, session TEXT NOT NULL, external_id TEXT NOT NULL,
  kind TEXT NOT NULL, locator TEXT NOT NULL, metadata TEXT NOT NULL, content TEXT, captured_at TEXT NOT NULL
);
CREATE TABLE bookmark_artifacts(bookmark_id INTEGER NOT NULL, artifact_id TEXT NOT NULL);
`;

function legacyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(LEGACY_DDL);
  db.prepare("INSERT INTO migration_units VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "unit-a", "Upgrade", "Move data", "Tests pass", '["node:a","node:b"]', "abc123",
    "blocked", 7, "amp", "lead-current",
  );
  db.prepare("INSERT INTO migration_bookmarks VALUES (?,?,?,?,?,?,?,?)").run(
    10, "unit-a", "handoff", "thread://handoff", "Transfer context", "amp", "lead-former", "2025-01-02T03:04:05.000Z",
  );
  db.prepare("INSERT INTO migration_bookmarks VALUES (?,?,?,?,?,?,?,?)").run(
    11, "unit-a", "decision", "thread://decision", "Legacy locator", "other", "observer", "2025-01-03T03:04:05.000Z",
  );
  db.prepare("INSERT INTO migration_handoffs VALUES (?,?,?,?,?,?,?,?)").run(
    4, "unit-a", 6, "amp", "lead-former", "amp", "lead-current", 10,
  );
  db.prepare("INSERT INTO session_artifacts VALUES (?,?,?,?,?,?,?,?,?)").run(
    "artifact-fixed-id", "amp", "lead-former", "native-9", "message", "thread://handoff",
    '{"result":"passed"}', "full artifact text", "2025-01-02T03:00:00.000Z",
  );
  db.prepare("INSERT INTO bookmark_artifacts VALUES (?,?)").run(10, "artifact-fixed-id");
  db.exec("CREATE TABLE graph_nodes(id TEXT PRIMARY KEY, payload TEXT); INSERT INTO graph_nodes VALUES ('n1','keep me')");
  return db;
}

function record<T>(db: DatabaseSync, table: string, id: string): T {
  // SAFETY: test-owned table and id names select data written by the upgrader as the requested coordination record.
  const row = db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id) as { data: string };
  return JSON.parse(row.data) as T;
}

test("upgrades complete legacy coordination data without touching graph tables", () => {
  const db = legacyDatabase();
  initializeCoordination(db);

  const unit = record<MigrationUnit>(db, "coordination_units", "unit-a");
  assert.equal(unit.revision, 7);
  assert.equal(unit.status, "blocked");
  assert.deepEqual(unit.lead, { provider: "amp", sessionId: "lead-current" });
  assert.deepEqual(unit.scope, { graphRevision: null, entityIds: ["node:a", "node:b"], sourceRevision: "abc123" });
  const current: SessionRef = { provider: "amp", sessionId: "lead-current" };
  const former: SessionRef = { provider: "amp", sessionId: "lead-former" };
  // SAFETY: the named column belongs to the coordination_sessions table.
  const memberships = db.prepare("SELECT unit_id FROM coordination_sessions WHERE key IN (?,?) ORDER BY session_id")
    .all(sessionKey(current), sessionKey(former)) as { unit_id: string }[];
  assert.deepEqual(memberships.map(({ unit_id }) => unit_id), ["unit-a", "unit-a"]);

  const artifact = record<Artifact>(db, "coordination_artifacts", "artifact-fixed-id");
  assert.equal(artifact.id, "artifact-fixed-id");
  assert.equal(artifact.nativeId, "native-9");
  assert.equal(artifact.text, "full artifact text");
  assert.deepEqual(artifact.metadata, { result: "passed" });
  const pinned = record<Bookmark>(db, "coordination_bookmarks", "10");
  assert.equal(pinned.artifactId, "artifact-fixed-id");
  const locatorOnly = record<Bookmark>(db, "coordination_bookmarks", "11");
  assert.equal(locatorOnly.artifactId, null);
  assert.deepEqual(locatorOnly.legacyLocator, { provider: "other", sessionId: "observer", locator: "thread://decision" });

  assert.equal((db.prepare("SELECT payload FROM graph_nodes WHERE id='n1'").get() as { payload: string }).payload, "keep me");
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='migration_units'").get(), undefined);
  // SAFETY: coordination_events.data contains serialized UnitEvent records.
  const events = db.prepare("SELECT data FROM coordination_events WHERE unit_id=? ORDER BY seq").all("unit-a") as { data: string }[];
  assert.deepEqual(events.map(({ data }) => (JSON.parse(data) as UnitEvent).revision), [7, 6]);

  initializeCoordination(db);
  assert.equal(record<MigrationUnit>(db, "coordination_units", "unit-a").revision, 7);
  assert.equal(record<Artifact>(db, "coordination_artifacts", "artifact-fixed-id").text, "full artifact text");
  db.close();
});

test("legacy upgrade rolls back atomically when session membership conflicts", () => {
  const db = legacyDatabase();
  db.prepare("INSERT INTO migration_units VALUES (?,?,?,?,?,?,?,?,?,?)").run(
    "unit-b", "Other", "Other", "Other", "[]", "def456", "planned", 1, "amp", "lead-current",
  );
  assert.throws(() => initializeCoordination(db), /lead of both/);
  assert.deepEqual(db.prepare("SELECT id FROM migration_units ORDER BY id").all().map((row) => row.id), ["unit-a", "unit-b"]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='coordination_version'").get(), undefined);
  assert.equal((db.prepare("SELECT payload FROM graph_nodes").get() as { payload: string }).payload, "keep me");
  db.close();
});

test("malformed legacy artifacts roll back previously imported units and sessions", () => {
  const db = legacyDatabase();
  db.exec("UPDATE session_artifacts SET metadata='not-json'");
  assert.throws(() => initializeCoordination(db), /malformed metadata/);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='coordination_units'").get(), undefined);
  assert.equal(db.prepare("SELECT id FROM migration_units").get()?.id, "unit-a");
  assert.equal(db.prepare("SELECT metadata FROM session_artifacts").get()?.metadata, "not-json");
  assert.equal(db.prepare("SELECT payload FROM graph_nodes").get()?.payload, "keep me");
  db.close();
});

test("rejects unsupported coordination schema versions without modifying data", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE coordination_version(version INTEGER NOT NULL); INSERT INTO coordination_version VALUES (99); CREATE TABLE graph_nodes(id TEXT); INSERT INTO graph_nodes VALUES ('n1')");
  assert.throws(() => initializeCoordination(db), /unsupported coordination schema version 99/);
  assert.deepEqual(db.prepare("SELECT id FROM graph_nodes").all().map((row) => row.id), ["n1"]);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='coordination_sessions'").get(), undefined);
  db.close();
});
