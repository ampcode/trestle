import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.ts";
import { migration } from "../src/store/migration.ts";
import { runCli } from "../src/cli/main.ts";
import { TOOLS } from "../src/server/serve.ts";

const create = {
  operation: "create", id: "orders", title: "Extract orders", objective: "Separate order processing",
  acceptance: "Contract tests pass", scope: ["Module:orders"], sourceRevision: "source-commit",
  provider: "amp", session: "session-1",
};

test("mandatory unique leads, CAS updates, and atomic handoffs with retained evidence", () => {
  const store = new Store(":memory:");
  try {
    assert.throws(() => migration(store, { ...create, session: undefined }), /session/);
    assert.deepEqual(migration(store, { operation: "list" }), []);
    migration(store, create);
    assert.throws(() => migration(store, { ...create, id: "other" }), /UNIQUE/);
    migration(store, { ...create, id: "other", session: "session-2" });
    const handoff = { operation: "handoff", id: "orders", revision: 1, provider: "amp", session: "session-2",
      locator: "artifact:handoff", description: "Continue from this evidence" };
    assert.throws(() => migration(store, handoff), /UNIQUE/);
    const before = migration(store, { operation: "get", id: "orders" }) as Record<string, unknown>;
    assert.equal(before.lead_session, "session-1");
    assert.deepEqual(before.bookmarks, []);
    assert.deepEqual(before.handoffs, []);
    migration(store, { ...handoff, provider: "codex" });
    assert.throws(() => migration(store, { operation: "status", id: "orders", revision: 1, status: "complete" }), /revision/);
    const completed = migration(store, { operation: "status", id: "orders", revision: 2, status: "complete" }) as Record<string, unknown>;
    assert.equal(completed.lead_session, "session-2");
    assert.equal(completed.lead_provider, "codex");
    assert.equal(completed.status, "complete");
    assert.equal(completed.revision, 3);
    assert.equal((completed.handoffs as unknown[]).length, 1);
    assert.equal((completed.bookmarks as unknown[]).length, 1);
    assert.throws(() => migration(store, { operation: "status", id: "orders", revision: 3, status: "bad" }), /status/);
    assert.throws(() => migration(store, { operation: "bookmark", id: "missing" }), /unknown/);
  } finally { store.close(); }
});

test("CLI and MCP share durable records; graph retirement preserves coordination", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-migration-"));
  const dbPath = join(dir, ".state", "trestle.db");
  try {
    await runCli(["migration", "create", JSON.stringify(create)], dir);
    const store = new Store(dbPath);
    try {
      store.retireAbandonedOwners([]);
      migration(store, { operation: "bookmark", id: "orders", kind: "verification", provider: "amp",
        session: "supporting-session", locator: "artifact:test-output", description: "Captured test output" });
    } finally { store.close(); }
    const tool = TOOLS.find(t => t.name === "migration")!;
    const result = JSON.parse(await tool.run({ dbPath, lockPath: join(dir, "absent"), projectionPath: join(dir, "absent") },
      { operation: "get", id: "orders" }));
    assert.equal(result.lead_session, "session-1");
    assert.deepEqual(result.scope, create.scope);
    assert.equal(result.bookmarks[0].session, "supporting-session");
    await assert.rejects(tool.run({ dbPath, lockPath: "", projectionPath: "" }, { ...create, id: "bad", provider: " " }), /provider/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
