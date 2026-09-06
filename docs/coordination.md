# Coordination API

Trestle records migration ownership and evidence; native agent harnesses own
execution. The core has no spawn, resume, message, scheduling, or worker API.
Its `coordination_*` tables share the graph's SQLite database but are not
replaced by extraction or resolution.

## Types and invariants

- `SessionRef = {provider, sessionId}` identifies an existing native session.
  Provider names are opaque strings, not a fixed list. `Session` adds optional
  `url` and `title`. Registering a session does not start it or prove it exists.
- `ObservedSession` adds `unitId`, `role` (`lead`, `contributor`, or null), and
  the latest `SessionObservation` (or null). An observation records `state`,
  timezone-qualified `observedAt`, and optional `nativeState`. States are
  `idle`, `working`, `awaiting-input`, `closed`, and `unknown`. Latest means
  greatest observation time, with ingestion order breaking ties. This is not
  a live availability guarantee. Never infer unit status from session activity.
- `MigrationUnit` contains `id`, `title`, `objective`, `acceptance`, `scope`,
  `lead`, `status`, and optimistic-concurrency `revision`. Scope contains
  `graphRevision`, `entityIds`, and `sourceRevision`: caller-supplied references,
  not independently validated snapshots. Contract and scope are immutable.
  Status is `planned`, `active`, `blocked`, or `complete`; it is reported,
  not proof that acceptance criteria passed.
- Every unit always has exactly one lead, even when complete. A registered
  session is unassigned or belongs to exactly one unit. Handoff retains the
  former lead as a contributor. No detach or automatic failover is provided.
- `UnitEvent` records creation, status, attachment, and handoff with actor,
  revision, timestamp, reason, and details. Session observation history is
  separate from unit history.
- `ArtifactInput` contains `session`, `nativeId`, `kind`, JSON `locator`, JSON
  object `metadata`, and optional `text`. `Artifact` adds a content-addressed
  `id` and `capturedAt`. Changing a captured payload creates another immutable
  version; identical imports reuse the original version and capture time.
- `Bookmark` pins one artifact ID to a unit with a `kind` (`decision`,
  `verification`, `blocker`, or `handoff`) and `description`. It never follows
  the native artifact's latest version. Evidence may reference other sessions
  without assigning them to the unit. `getBookmark` includes captured evidence.

## Embedded and transport APIs

```ts
import { Coordination, callCoordination } from "trestle/coordination";

// db is the application's existing node:sqlite DatabaseSync connection.
// Actor comes from the trusted host, never model-supplied request arguments.
const core = new Coordination(db, trustedActor);
core.registerSession({ ref: { provider: "codex", sessionId: "native-1" } }, "register-1");
const units = core.listUnits();
```

All types, `Coordination`, `callCoordination`, and `coordinationSchema` are
exported from this submodule. The caller owns the database connection.
Mutations and schema initialization own their transactions; do not nest them
inside a caller transaction.

The MCP tool is `coordination`. Its envelope is:

```json
{
  "operation": "setUnitStatus",
  "arguments": {
    "id": "orders",
    "expectedRevision": 1,
    "status": "active",
    "reason": "Implementation started"
  },
  "requestId": "orders-active-1"
}
```

The equivalent CLI is:

```sh
npx trestle coordination setUnitStatus '{"id":"orders","expectedRevision":1,"status":"active","reason":"Implementation started"}' orders-active-1
```

Every mutation requires a stable request ID (the last parameter for embedded
methods). The transaction stores its result under actor + request ID. Retrying
identical arguments returns that original result, even after a process restart
or later changes. Reusing the key for different arguments fails. Use a fresh
key for a new observation or changed artifact capture, not for an exact retry.
Failed transactions leave neither partial changes nor a successful request record.

### Operations

The table lists JSON `arguments`. Embedded methods expose the same concepts
through typed parameters in `src/coordination/core.ts`.

| Operation | Arguments | Result |
| --- | --- | --- |
| `registerSession` | `ref`, optional `url`, `title` | Observed session; omitted metadata stays unchanged |
| `observeSession` | `session`, `state`, `observedAt`, optional `nativeState` | Recorded observation |
| `getSession` | `ref` | Observed session |
| `listSessions` | optional `provider`, `unitId`, `state`, `offset` | Session page |
| `getSessionHistory` | `ref`, optional `offset` | Observation page |
| `createUnit` | `id`, `title`, `objective`, `acceptance`, `scope`, `lead` | Unit, planned at revision 1 |
| `getUnit` | `id` | Unit |
| `listUnits` | optional `status`, `offset` | Unit page |
| `setUnitStatus` | `id`, `expectedRevision`, `status`, `reason` | Updated unit |
| `attachSession` | `unitId`, `ref` | Observed session |
| `handoffLead` | `id`, `expectedRevision`, `newLead`, `bookmarkId` | Updated unit |
| `getUnitHistory` | `id`, optional `offset` | Event page |
| `indexArtifacts` | `artifacts` (1–20 inputs) | Artifact array |
| `searchArtifacts` | optional `provider`, `session`, `kind`, `query`, `offset` | Artifact summary page |
| `getArtifact` | `id` | Full captured artifact |
| `createBookmark` | `unitId`, `artifactId`, `kind`, `description` | Bookmark |
| `getBookmark` | `id` | Bookmark plus artifact |
| `listBookmarks` | `unitId`, optional `kind`, `offset` | Bookmark page |

Register sessions before observing, assigning, or indexing them. Status changes
and handoffs reject stale revisions. First-time attachment also increments the
unit revision; attaching an already attached session is a no-op. Handoff requires
an existing, pinned, handoff-kind bookmark for the same unit. Changing the lead,
membership, revision, and history is one transaction. Creating the supporting
artifact and bookmark are separate calls and can survive a failed handoff.

Pages contain up to 20 items and return `{items, nextOffset}`; null ends the
scan. Offset pagination is not a snapshot across concurrent writes. Artifact
search is literal case-insensitive substring matching over metadata and captured
text. Summaries omit text and include `textCaptured`; use `getArtifact` for text.

## Connector boundary

`HarnessConnector` is read-only:

```ts
interface HarnessConnector {
  provider: string;
  capabilities: { activity: boolean; fullHistory: boolean; artifactContent: boolean };
  readSession(ref: SessionRef): Promise<SessionSnapshot | Unsupported>;
  readHistory(ref: SessionRef, cursor?: string): Promise<HistoryPage | Unsupported>;
}
```

`SessionSnapshot` supplies a session and optional observation. `HistoryPage`
supplies artifact inputs and an optional opaque `nextCursor`. Unsupported
operations return `{unsupported: true, reason}`; operational failures may throw.
The host chooses a connector, registers the session, submits observations and
artifact pages, and supplies request IDs. Trestle does not run a polling loop.
Providers need no changes to core tables, statuses, or identity types.

The optional Amp plugin implements this contract through `createAmpConnector`.
Its convenience tool binds identity to the invoking Amp thread. Amp history
capture defaults to metadata only; explicit text capture includes visible text,
never thinking or tool inputs/outputs. Other providers can implement their own
connectors or submit the same API envelopes without using Amp.

## Trust, privacy, and upgrade

CLI attribution is `local:<OS username>`. The current MCP transport uses
`portal-service` (or a trusted host's `coordinationActor` configuration), not a
verified per-user identity. `actor` supplied in request data is rejected. This
is service-level audit attribution, not per-user authorization or proof that
the named session authored the request. Keep the writable endpoint behind a
trusted access boundary; a multi-user host must supply verified identity and
enforce its permissions outside this core.

Capture text only with approval, and redact sensitive material before import.
Metadata itself may be sensitive. Trestle neither redacts automatically nor
verifies artifact assertions. Captures and mutation results share the database's
access, retention, and backup policy. Metadata-only bookmarks preserve references,
not the original transcript.

The old `migration` CLI/MCP API and store implementations are removed. Opening
the new core automatically upgrades the legacy coordination tables in one
transaction, retaining unit revisions, IDs, artifacts, pins, and handoffs, then
drops those legacy tables. Graph tables are untouched. Back up a deployment's
database before upgrading; old binaries cannot use the upgraded tables.

Legacy units lack graph revisions (`scope.graphRevision: null`); new units must
supply a non-negative integer. Legacy locator-only bookmarks remain readable
with `artifactId: null`, but new bookmarks always pin artifacts. Unknown historical
timestamps/status events are explicitly marked as imported, never fabricated.
Conflicting session ownership or malformed legacy data aborts and rolls back
the entire upgrade so the original data remains available for explicit repair.
