import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { canonicalJson, sha256 } from "../profile/canonical.ts";
import { isString, isNumber, isProperties, isJsonValue, type JsonValue } from "../profile/value.ts";
import { initializeCoordination, sessionKey } from "./schema.ts";
import type {
  Artifact, ArtifactInput, ArtifactFilter, ArtifactSummary, Bookmark, BookmarkEvidence, BookmarkFilter,
  BookmarkKind, CreateUnit, MigrationUnit, ObservedSession, Page, Session, SessionFilter,
  SessionObservation, SessionRef, UnitEvent, UnitFilter, UnitStatus,
} from "./types.ts";

type DataRow = { data: string };
type SessionRow = DataRow & { unit_id: string | null };
type RequestRow = { fingerprint: string; result: string };

function nonempty(value: string, name: string): void {
  if (!isString(value) || !value.trim()) throw new Error(`${name} must be a non-empty string`);
}
function refKey(ref: SessionRef): string {
  if (!isProperties(ref)) throw new Error("session reference must be an object");
  nonempty(ref.provider, "provider"); nonempty(ref.sessionId, "sessionId");
  return sessionKey(ref);
}
function offsetValue(offset = 0): number {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  return offset;
}
function jsonRecord<T>(row: DataRow): T {
  // SAFETY: private coordination tables are written only with validated typed records or the schema upgrader.
  return JSON.parse(row.data) as T;
}

/** The actor is supplied by a trusted host/transport, never by request arguments. */
export class Coordination {
  private readonly db: DatabaseSync;
  private readonly actor: string;

  constructor(db: DatabaseSync, actor: string) {
    nonempty(actor, "actor");
    this.db = db;
    this.actor = actor;
    initializeCoordination(db);
  }

  private mutate<T extends JsonValue>(operation: string, input: JsonValue, requestId: string, action: () => T): T {
    nonempty(requestId, "requestId");
    const fingerprint = sha256(canonicalJson({ operation, input }));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // SAFETY: coordination_requests schema fixes the two selected TEXT columns.
      const old = this.db.prepare("SELECT fingerprint,result FROM coordination_requests WHERE actor=? AND request_id=?")
        .get(this.actor, requestId) as RequestRow | undefined;
      if (old) {
        if (old.fingerprint !== fingerprint) throw new Error("requestId already used with different arguments");
        this.db.exec("COMMIT");
        // SAFETY: a matching operation/input fingerprint selects the result of this same typed mutation.
        return JSON.parse(old.result) as T;
      }
      const result = action();
      this.db.prepare("INSERT INTO coordination_requests VALUES (?,?,?,?)")
        .run(this.actor, requestId, fingerprint, JSON.stringify(result));
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private page<T>(sql: string, values: SQLInputValue[], offset = 0): Page<T> {
    // SAFETY: callers select a JSON data column from a coordination table with a single record type.
    const rows = this.db.prepare(`${sql} LIMIT 21 OFFSET ?`).all(...values, offsetValue(offset)) as DataRow[];
    return { items: rows.slice(0, 20).map(row => jsonRecord<T>(row)), nextOffset: rows.length > 20 ? offset + 20 : null };
  }

  registerSession(input: Session, requestId: string): ObservedSession {
    const key = refKey(input.ref);
    if (input.url !== undefined) nonempty(input.url, "url");
    if (input.title !== undefined) nonempty(input.title, "title");
    return this.mutate("registerSession", input, requestId, () => {
      const old = this.db.prepare("SELECT data FROM coordination_sessions WHERE key=?").get(key);
      // SAFETY: selected data is serialized Session from coordination_sessions.
      const previous = old ? jsonRecord<Session>(old as DataRow) : { ref: input.ref };
      const session: Session = { ...previous };
      if (input.title !== undefined) session.title = input.title;
      if (input.url !== undefined) session.url = input.url;
      this.db.prepare(`INSERT INTO coordination_sessions(key,provider,session_id,data) VALUES (?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET data=excluded.data`).run(key, input.ref.provider, input.ref.sessionId, JSON.stringify(session));
      return this.getSession(input.ref);
    });
  }

  getSession(ref: SessionRef): ObservedSession {
    const key = refKey(ref);
    // SAFETY: coordination_sessions defines data TEXT and unit_id nullable TEXT.
    const row = this.db.prepare("SELECT data,unit_id FROM coordination_sessions WHERE key=?").get(key) as SessionRow | undefined;
    if (!row) throw new Error("session is not registered");
    const observation = this.db.prepare("SELECT data FROM coordination_observations WHERE session_key=? ORDER BY observed_at DESC,seq DESC LIMIT 1").get(key);
    const unit = row.unit_id ? this.getUnit(row.unit_id) : null;
    return { ...jsonRecord<Session>(row), unitId: row.unit_id,
      role: unit ? (sessionKey(unit.lead) === key ? "lead" : "contributor") : null,
      // SAFETY: observation data is serialized SessionObservation written by observeSession.
      observation: observation ? jsonRecord<SessionObservation>(observation as DataRow) : null };
  }

  observeSession(input: SessionObservation, requestId: string): SessionObservation {
    refKey(input.session);
    if (!["idle", "working", "awaiting-input", "closed", "unknown"].includes(input.state)) throw new Error("invalid session state");
    if (!isString(input.observedAt) || !/^\d{4}-\d\d-\d\dT/.test(input.observedAt) || !/(Z|[+-]\d\d:\d\d)$/.test(input.observedAt) || !Number.isFinite(Date.parse(input.observedAt))) {
      throw new Error("observedAt must be an ISO timestamp with timezone");
    }
    if (input.nativeState !== undefined) nonempty(input.nativeState, "nativeState");
    return this.mutate("observeSession", input, requestId, () => {
      this.getSession(input.session);
      const observation = { ...input, observedAt: new Date(input.observedAt).toISOString() };
      this.db.prepare("INSERT INTO coordination_observations(session_key,observed_at,data) VALUES (?,?,?)")
        .run(sessionKey(input.session), observation.observedAt, JSON.stringify(observation));
      return observation;
    });
  }

  getSessionHistory(ref: SessionRef, offset = 0): Page<SessionObservation> {
    this.getSession(ref);
    return this.page("SELECT data FROM coordination_observations WHERE session_key=? ORDER BY observed_at,seq", [refKey(ref)], offset);
  }

  listSessions(filter: SessionFilter = {}): Page<ObservedSession> {
    const where: string[] = [], values: SQLInputValue[] = [];
    if (filter.provider !== undefined) { where.push("s.provider=?"); values.push(filter.provider); }
    if (filter.unitId !== undefined) { where.push("s.unit_id=?"); values.push(filter.unitId); }
    if (filter.state !== undefined) {
      where.push("coalesce((SELECT json_extract(o.data,'$.state') FROM coordination_observations o WHERE o.session_key=s.key ORDER BY o.observed_at DESC,o.seq DESC LIMIT 1),'unknown')=?");
      values.push(filter.state);
    }
    const page = this.page<Session>(`SELECT s.data FROM coordination_sessions s ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.rowid`, values, filter.offset);
    return { ...page, items: page.items.map(session => this.getSession(session.ref)) };
  }

  createUnit(input: CreateUnit, requestId: string): MigrationUnit {
    for (const name of ["id", "title", "objective", "acceptance"] as const) nonempty(input[name], name);
    refKey(input.lead);
    if (!isProperties(input.scope) || !isNumber(input.scope.graphRevision) || !Number.isSafeInteger(input.scope.graphRevision) || input.scope.graphRevision < 0) throw new Error("scope.graphRevision must be a non-negative integer");
    if (!Array.isArray(input.scope.entityIds) || !input.scope.entityIds.every(id => isString(id) && id.trim())) throw new Error("scope.entityIds must be strings");
    nonempty(input.scope.sourceRevision, "scope.sourceRevision");
    return this.mutate("createUnit", input, requestId, () => {
      const lead = this.getSession(input.lead);
      if (lead.unitId) throw new Error("lead session already belongs to a unit");
      const unit: MigrationUnit = { ...input, status: "planned", revision: 1 };
      this.db.prepare("INSERT INTO coordination_units(id,revision,lead_key,data) VALUES (?,?,?,?)")
        .run(unit.id, 1, sessionKey(unit.lead), JSON.stringify(unit));
      this.db.prepare("UPDATE coordination_sessions SET unit_id=? WHERE key=?").run(unit.id, sessionKey(unit.lead));
      this.event(unit, "created", "Unit created", {});
      return unit;
    });
  }

  getUnit(id: string): MigrationUnit {
    nonempty(id, "id");
    // SAFETY: coordination_units.data contains a MigrationUnit written by create/update or upgrade.
    const row = this.db.prepare("SELECT data FROM coordination_units WHERE id=?").get(id) as DataRow | undefined;
    if (!row) throw new Error(`unknown unit: ${id}`);
    return jsonRecord<MigrationUnit>(row);
  }

  listUnits(filter: UnitFilter = {}): Page<MigrationUnit> {
    return this.page(`SELECT data FROM coordination_units ${filter.status ? "WHERE json_extract(data,'$.status')=?" : ""} ORDER BY rowid`, filter.status ? [filter.status] : [], filter.offset);
  }

  private saveUnit(unit: MigrationUnit): MigrationUnit {
    this.db.prepare("UPDATE coordination_units SET revision=?,lead_key=?,data=? WHERE id=?")
      .run(unit.revision, sessionKey(unit.lead), JSON.stringify(unit), unit.id);
    return unit;
  }

  private expectedUnit(id: string, expectedRevision: number): MigrationUnit {
    const unit = this.getUnit(id);
    if (!Number.isSafeInteger(expectedRevision) || unit.revision !== expectedRevision) throw new Error("stale unit revision");
    return unit;
  }

  private event(unit: MigrationUnit, kind: UnitEvent["kind"], reason: string, details: UnitEvent["details"]): void {
    const event: UnitEvent = { id: randomUUID(), unitId: unit.id, revision: unit.revision, actor: this.actor,
      recordedAt: new Date().toISOString(), kind, reason, details };
    this.db.prepare("INSERT INTO coordination_events(unit_id,data) VALUES (?,?)").run(unit.id, JSON.stringify(event));
  }

  setUnitStatus(id: string, expectedRevision: number, status: UnitStatus, reason: string, requestId: string): MigrationUnit {
    if (!["planned", "active", "blocked", "complete"].includes(status)) throw new Error("invalid migration status");
    nonempty(reason, "reason");
    return this.mutate("setUnitStatus", { id, expectedRevision, status, reason }, requestId, () => {
      const old = this.expectedUnit(id, expectedRevision);
      const unit = this.saveUnit({ ...old, status, revision: old.revision + 1 });
      this.event(unit, "status", reason, { previousStatus: old.status, status });
      return unit;
    });
  }

  attachSession(unitId: string, ref: SessionRef, requestId: string): ObservedSession {
    refKey(ref);
    return this.mutate("attachSession", { unitId, ref }, requestId, () => {
      const unit = this.getUnit(unitId), session = this.getSession(ref);
      if (session.unitId && session.unitId !== unitId) throw new Error("session already belongs to another unit");
      if (!session.unitId) {
        this.db.prepare("UPDATE coordination_sessions SET unit_id=? WHERE key=?").run(unitId, sessionKey(ref));
        unit.revision++;
        this.saveUnit(unit);
        this.event(unit, "attached", "Supporting session attached", { session: ref });
      }
      return this.getSession(ref);
    });
  }

  handoffLead(id: string, expectedRevision: number, newLead: SessionRef, bookmarkId: string, requestId: string): MigrationUnit {
    refKey(newLead);
    return this.mutate("handoffLead", { id, expectedRevision, newLead, bookmarkId }, requestId, () => {
      const old = this.expectedUnit(id, expectedRevision), session = this.getSession(newLead);
      if (sessionKey(old.lead) === sessionKey(newLead)) throw new Error("replacement lead must differ");
      if (session.unitId && session.unitId !== id) throw new Error("session already belongs to another unit");
      const bookmark = this.getBookmark(bookmarkId);
      if (bookmark.unitId !== id || bookmark.kind !== "handoff" || !bookmark.artifact) throw new Error("handoff needs a pinned handoff bookmark for this unit");
      this.db.prepare("UPDATE coordination_sessions SET unit_id=? WHERE key=?").run(id, sessionKey(newLead));
      const unit = this.saveUnit({ ...old, lead: newLead, revision: old.revision + 1 });
      this.event(unit, "handoff", bookmark.description, { previousLead: old.lead, lead: newLead, bookmarkId });
      return unit;
    });
  }

  getUnitHistory(id: string, offset = 0): Page<UnitEvent> {
    this.getUnit(id);
    return this.page("SELECT data FROM coordination_events WHERE unit_id=? ORDER BY seq", [id], offset);
  }

  indexArtifacts(inputs: ArtifactInput[], requestId: string): Artifact[] {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20) throw new Error("artifacts must contain 1–20 records");
    for (const input of inputs) {
      refKey(input.session);
      nonempty(input.nativeId, "nativeId"); nonempty(input.kind, "kind");
      if (input.locator === undefined || !isJsonValue(input.locator)) throw new Error("locator must be JSON");
      if (!isProperties(input.metadata)) throw new Error("metadata must be a JSON object");
      if (input.text !== undefined && !isString(input.text)) throw new Error("text must be a string");
    }
    return this.mutate("indexArtifacts", inputs, requestId, () => inputs.map(input => {
      this.getSession(input.session);
      const id = sha256(canonicalJson(input));
      // SAFETY: coordination_artifacts.data is an Artifact.
      const old = this.db.prepare("SELECT data FROM coordination_artifacts WHERE id=?").get(id) as DataRow | undefined;
      if (old) return jsonRecord<Artifact>(old);
      const artifact: Artifact = { ...input, id, capturedAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO coordination_artifacts(id,session_key,kind,data,search_text) VALUES (?,?,?,?,?)")
        .run(id, sessionKey(input.session), input.kind, JSON.stringify(artifact), `${canonicalJson(input.metadata)}\n${input.text ?? ""}`);
      return artifact;
    }));
  }

  getArtifact(id: string): Artifact {
    nonempty(id, "id");
    // SAFETY: coordination_artifacts.data is an Artifact.
    const row = this.db.prepare("SELECT data FROM coordination_artifacts WHERE id=?").get(id) as DataRow | undefined;
    if (!row) throw new Error("unknown artifact");
    return jsonRecord<Artifact>(row);
  }

  searchArtifacts(filter: ArtifactFilter = {}): Page<ArtifactSummary> {
    const clauses: string[] = [], values: SQLInputValue[] = [];
    if (filter.provider !== undefined) { clauses.push("json_extract(data,'$.session.provider')=?"); values.push(filter.provider); }
    if (filter.session !== undefined) { clauses.push("session_key=?"); values.push(refKey(filter.session)); }
    if (filter.kind !== undefined) { clauses.push("kind=?"); values.push(filter.kind); }
    if (filter.query !== undefined) { clauses.push("instr(lower(search_text),lower(?))>0"); values.push(filter.query); }
    const result = this.page<Artifact>(`SELECT data FROM coordination_artifacts ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY rowid`, values, filter.offset);
    return { ...result, items: result.items.map(({ text, ...rest }) => ({ ...rest, textCaptured: text !== undefined })) };
  }

  createBookmark(unitId: string, artifactId: string, kind: BookmarkKind, description: string, requestId: string): Bookmark {
    if (!["decision", "verification", "blocker", "handoff"].includes(kind)) throw new Error("invalid bookmark kind");
    nonempty(description, "description");
    return this.mutate("createBookmark", { unitId, artifactId, kind, description }, requestId, () => {
      this.getUnit(unitId); this.getArtifact(artifactId);
      const bookmark: Bookmark = { id: randomUUID(), unitId, artifactId, kind, description, createdAt: new Date().toISOString() };
      this.db.prepare("INSERT INTO coordination_bookmarks VALUES (?,?,?,?)").run(bookmark.id, unitId, artifactId, JSON.stringify(bookmark));
      return bookmark;
    });
  }

  getBookmark(id: string): BookmarkEvidence {
    nonempty(id, "id");
    // SAFETY: coordination_bookmarks.data is a Bookmark.
    const row = this.db.prepare("SELECT data FROM coordination_bookmarks WHERE id=?").get(id) as DataRow | undefined;
    if (!row) throw new Error("unknown bookmark");
    const bookmark = jsonRecord<Bookmark>(row);
    return { ...bookmark, artifact: bookmark.artifactId ? this.getArtifact(bookmark.artifactId) : null };
  }

  listBookmarks(unitId: string, filter: BookmarkFilter = {}): Page<Bookmark> {
    this.getUnit(unitId);
    return this.page(`SELECT data FROM coordination_bookmarks WHERE unit_id=? ${filter.kind ? "AND json_extract(data,'$.kind')=?" : ""} ORDER BY rowid`, filter.kind ? [unitId, filter.kind] : [unitId], filter.offset);
  }
}
