import type { JsonValue, Properties } from "../profile/value.ts";

export type SessionRef = { provider: string; sessionId: string };
export type SessionState = "idle" | "working" | "awaiting-input" | "closed" | "unknown";
export type UnitStatus = "planned" | "active" | "blocked" | "complete";
export type BookmarkKind = "decision" | "verification" | "blocker" | "handoff";
export type Session = { ref: SessionRef; url?: string; title?: string };
export type SessionObservation = {
  session: SessionRef; state: SessionState; observedAt: string; nativeState?: string;
};
export type ObservedSession = Session & {
  unitId: string | null;
  role: "lead" | "contributor" | null;
  observation: SessionObservation | null;
};
export type UnitScope = {
  /** Null only for imported legacy units whose graph revision was not recorded. */
  graphRevision: number | null;
  entityIds: string[];
  sourceRevision: string;
};
export type CreateUnit = {
  id: string; title: string; objective: string; acceptance: string; scope: UnitScope; lead: SessionRef;
};
export type MigrationUnit = CreateUnit & { status: UnitStatus; revision: number };
export type UnitEvent = {
  id: string; unitId: string; revision: number; actor: string; recordedAt: string;
  kind: "created" | "status" | "attached" | "handoff" | "imported";
  reason: string; details: Properties;
};
export type ArtifactInput = {
  session: SessionRef; nativeId: string; kind: string; locator: JsonValue; metadata: Properties; text?: string;
};
export type Artifact = ArtifactInput & { id: string; capturedAt: string };
export type ArtifactSummary = Omit<Artifact, "text"> & { textCaptured: boolean };
export type Bookmark = {
  id: string; unitId: string;
  /** Null only for imported locator-only bookmarks. New bookmarks always pin artifacts. */
  artifactId: string | null;
  kind: BookmarkKind; description: string; createdAt: string;
  legacyLocator?: JsonValue;
};
export type BookmarkEvidence = Bookmark & { artifact: Artifact | null };
export type Page<T> = { items: T[]; nextOffset: number | null };
export type SessionFilter = { provider?: string; unitId?: string; state?: SessionState; offset?: number };
export type UnitFilter = { status?: UnitStatus; offset?: number };
export type ArtifactFilter = { provider?: string; session?: SessionRef; kind?: string; query?: string; offset?: number };
export type BookmarkFilter = { kind?: BookmarkKind; offset?: number };
export type SessionSnapshot = { session: Session; observation?: SessionObservation };
export type Unsupported = { unsupported: true; reason: string };
export type HistoryPage = { artifacts: ArtifactInput[]; nextCursor?: string };

/** Read-only connector contract. The caller schedules indexing; the core never executes agents. */
export interface HarnessConnector {
  provider: string;
  capabilities: { activity: boolean; fullHistory: boolean; artifactContent: boolean };
  readSession(ref: SessionRef): Promise<SessionSnapshot | Unsupported>;
  readHistory(ref: SessionRef, cursor?: string): Promise<HistoryPage | Unsupported>;
}
