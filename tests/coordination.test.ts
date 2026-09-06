import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.ts";
import { Coordination, callCoordination } from "../src/coordination/index.ts";
import type { CreateUnit, ArtifactInput } from "../src/coordination/types.ts";
import { runCli } from "../src/cli/main.ts";

const lead = { provider: "amp", sessionId: "same-native-id" };
const other = { provider: "codex", sessionId: "same-native-id" };
const unit: CreateUnit = { id: "orders", title: "Orders", objective: "Separate orders", acceptance: "Contract tests pass",
  scope: { graphRevision: 0, entityIds: ["Module:orders"], sourceRevision: "pinned-commit" }, lead };
const artifact: ArtifactInput = { session: lead, nativeId: "message-1", kind: "message", locator: { message: "message-1" },
  metadata: { role: "assistant" }, text: "17 tests passed" };

test("registered sessions, single-unit membership, CAS history and durable idempotency", () => {
  const dir = mkdtempSync(join(tmpdir(), "coordination-"));
  let store = new Store(join(dir, "trestle.db"));
  try {
    let core = new Coordination(store.db, "test-user");
    assert.throws(() => core.createUnit(unit, "create"), /registered/);
    core.registerSession({ ref: lead, title: "Lead" }, "register-lead");
    core.registerSession({ ref: other }, "register-other");
    assert.equal(core.getSession(lead).observation, null);
    const created = core.createUnit(unit, "create");
    assert.deepEqual(core.createUnit(unit, "create"), created);
    assert.throws(() => core.createUnit({ ...unit, title: "Different" }, "create"), /different arguments/);
    assert.throws(() => core.createUnit({ ...unit, id: "duplicate" }, "duplicate"), /belongs/);
    core.attachSession("orders", other, "attach");
    assert.equal(core.getUnit("orders").revision, 2);
    assert.equal(core.getSession(other).role, "contributor");
    assert.throws(() => core.createUnit({ ...unit, id: "other", lead: other }, "another-unit"), /belongs/);
    assert.throws(() => core.setUnitStatus("orders", 1, "active", "Start", "stale"), /stale/);
    const active = core.setUnitStatus("orders", 2, "active", "Begin migration", "activate");
    assert.deepEqual(core.setUnitStatus("orders", 2, "active", "Begin migration", "activate"), active);
    assert.deepEqual(core.getUnitHistory("orders").items.map(event => [event.kind, event.actor]),
      [["created", "test-user"], ["attached", "test-user"], ["status", "test-user"]]);
    store.close(); store = new Store(join(dir, "trestle.db"));
    core = new Coordination(store.db, "test-user");
    assert.deepEqual(core.setUnitStatus("orders", 2, "active", "Begin migration", "activate"), active);
    store.retireAbandonedOwners([]);
    assert.deepEqual(core.getUnit("orders"), active);
    assert.deepEqual(core.listSessions({ unitId: "orders" }).items.map(s => s.role), ["lead", "contributor"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("observations retain history, respect event time and never drive migration status", () => {
  const store = new Store(":memory:");
  try {
    const core = new Coordination(store.db, "test");
    core.registerSession({ ref: lead, title: "Keep me" }, "register");
    callCoordination(core, { operation: "registerSession", arguments: { ref: lead, url: "native:session" }, requestId: "refresh" });
    assert.equal(core.getSession(lead).title, "Keep me");
    core.createUnit(unit, "create");
    const observation = { session: lead, state: "working" as const, observedAt: "2026-09-07T01:00:00Z", nativeState: "running" };
    core.observeSession(observation, "observe");
    core.observeSession(observation, "observe");
    core.observeSession({ ...observation, state: "closed", observedAt: "2026-09-06T23:00:00Z" }, "older");
    assert.equal(core.getSession(lead).observation?.state, "working");
    assert.equal(core.getSessionHistory(lead).items.length, 2);
    assert.equal(core.listSessions({ state: "working" }).items.length, 1);
    assert.equal(core.getUnit("orders").status, "planned");
    assert.throws(() => core.observeSession({ ...observation, observedAt: "yesterday" }, "invalid"), /ISO/);
    core.observeSession({ ...observation, state: "closed", observedAt: "2026-09-08T00:00:00Z" }, "closed");
    assert.deepEqual(core.getUnit("orders").lead, lead);
  } finally { store.close(); }
});

test("immutable artifacts, pinned bookmarks and atomic lead handoffs", () => {
  const store = new Store(":memory:");
  try {
    const core = new Coordination(store.db, "test");
    core.registerSession({ ref: lead }, "lead"); core.registerSession({ ref: other }, "other");
    core.createUnit(unit, "unit");
    const first = core.indexArtifacts([artifact], "index")[0];
    assert.deepEqual(core.indexArtifacts([artifact], "repeat"), [first]);
    const revised = core.indexArtifacts([{ ...artifact, text: "Correction: tests failed" }], "revised")[0];
    assert.notEqual(first.id, revised.id);
    const crossProvider = core.indexArtifacts([{ ...artifact, session: other }], "other-artifact")[0];
    assert.notEqual(first.id, crossProvider.id);
    const bookmark = core.createBookmark("orders", first.id, "handoff", "Continue from this evidence", "bookmark");
    assert.deepEqual(core.createBookmark("orders", first.id, "handoff", "Continue from this evidence", "bookmark"), bookmark);
    assert.equal(core.getBookmark(bookmark.id).artifact?.text, "17 tests passed");
    const handoff = core.handoffLead("orders", 1, other, bookmark.id, "handoff");
    assert.deepEqual(core.handoffLead("orders", 1, other, bookmark.id, "handoff"), handoff);
    assert.equal(core.getSession(other).role, "lead");
    assert.equal(core.getSession(lead).role, "contributor");
    assert.deepEqual(core.getUnitHistory("orders").items[1].details.previousLead, lead);
    assert.equal(core.listBookmarks("orders").items.length, 1);
    assert.equal(core.searchArtifacts({ provider: "amp", query: "PASSED" }).items.length, 1);
    assert.equal("text" in core.searchArtifacts().items[0], false);
    assert.throws(() => core.indexArtifacts([{ ...artifact, nativeId: "new" }, { ...artifact, session: { provider: "missing", sessionId: "no" } }], "bad-batch"), /registered/);
    assert.equal(core.searchArtifacts().items.length, 3);
    const third = { provider: "devin", sessionId: "third" };
    core.registerSession({ ref: third }, "third");
    core.createUnit({ ...unit, id: "another", lead: third }, "another");
    assert.throws(() => core.handoffLead("orders", 2, third, bookmark.id, "conflicting"), /another unit/);
    assert.deepEqual(core.getUnit("orders").lead, other);
    assert.equal(core.getUnitHistory("orders").items.length, 2);
  } finally { store.close(); }
});

test("bounded pagination and JSON boundary validation", () => {
  const store = new Store(":memory:");
  try {
    const core = new Coordination(store.db, "test");
    for (let i = 0; i < 22; i++) core.registerSession({ ref: { provider: "test", sessionId: String(i) } }, `session-${i}`);
    const first = core.listSessions();
    assert.equal(first.items.length, 20);
    assert.equal(first.nextOffset, 20);
    assert.equal(core.listSessions({ offset: 20 }).items.length, 2);
    assert.equal(core.listSessions({ offset: 20 }).nextOffset, null);
    assert.throws(() => callCoordination(core, { operation: "createUnit", arguments: {} }), /object/);
    assert.throws(() => callCoordination(core, { operation: "registerSession", arguments: { ref: lead } }), /string/);
    assert.throws(() => callCoordination(core, { operation: "registerSession", arguments: { ref: lead }, actor: "forged", requestId: "x" }), /transport/);
    assert.throws(() => callCoordination(core, { operation: "listSessions", arguments: { offset: -1 } }), /integer/);
    assert.throws(() => callCoordination(core, { operation: "old-migration", arguments: {} }), /expected one/);
  } finally { store.close(); }
});

test("CLI uses the new API without any harness plugin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coordination-cli-"));
  try {
    await runCli(["coordination", "registerSession", JSON.stringify({ ref: lead }), "register"], dir);
    await runCli(["coordination", "createUnit", JSON.stringify(unit), "create"], dir);
    const store = new Store(join(dir, ".state", "trestle.db"));
    try { assert.deepEqual(new Coordination(store.db, "reader").getUnit("orders").lead, lead); }
    finally { store.close(); }
    await assert.rejects(runCli(["migration", "list"], dir), /unknown command/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
