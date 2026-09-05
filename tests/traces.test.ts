import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.ts";
import { migration } from "../src/store/migration.ts";

test("provider-neutral immutable artifacts, pinned bookmarks, and persistence", () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-traces-"));
  let store = new Store(join(dir, "trestle.db"));
  const item = { externalId: "message-1", kind: "message", locator: "native:message-1", metadata: { role: "assistant" }, content: "Contract tests passed" };
  const input = { operation: "artifact-import", provider: "codex", session: "session", artifacts: [item] };
  try {
    const first = migration(store, input) as { id: string }[];
    assert.deepEqual(migration(store, input), first);
    const other = migration(store, { ...input, provider: "cursor" }) as { id: string }[];
    assert.notEqual(other[0].id, first[0].id);
    migration(store, { operation: "create", id: "unit", title: "Unit", objective: "Migrate", acceptance: "Tests", scope: [], sourceRevision: "commit", provider: "codex", session: "session" });
    const unit = migration(store, { operation: "bookmark", id: "unit", artifactId: first[0].id, kind: "verification", description: "Test evidence" }) as { bookmarks: { id: number }[] };
    const changed = migration(store, { ...input, artifacts: [{ ...item, content: "Corrected: tests failed" }] }) as { id: string }[];
    assert.notEqual(changed[0].id, first[0].id);
    store.close();
    store = new Store(join(dir, "trestle.db"));
    const bookmark = migration(store, { operation: "bookmark-get", bookmarkId: unit.bookmarks[0].id }) as { artifact: { content: string } };
    assert.equal(bookmark.artifact.content, item.content);
    const search = migration(store, { operation: "artifact-search", provider: "codex", query: "PASSED" }) as { artifacts: { id: string; content?: string }[] };
    assert.deepEqual(search.artifacts.map(a => a.id), [first[0].id]);
    assert.equal(search.artifacts[0].content, undefined);
    assert.throws(() => migration(store, { operation: "bookmark", id: "unit", artifactId: first[0].id, provider: "amp", kind: "decision", description: "bad attribution" }), /does not match/);
    assert.throws(() => migration(store, { operation: "artifact-get", artifactId: "missing" }), /unknown artifact/);
    assert.throws(() => migration(store, { ...input, artifacts: [{ ...item, externalId: "new" }, { kind: "bad" }] }), /externalId/);
    const all = migration(store, { operation: "artifact-search" }) as { artifacts: unknown[] };
    assert.equal(all.artifacts.length, 3);
    store.retireAbandonedOwners([]);
    assert.deepEqual(migration(store, input), first);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("metadata-only indexing and stable bounded pagination", () => {
  const store = new Store(":memory:");
  try {
    for (let batch = 0; batch < 2; batch++) migration(store, { operation: "artifact-import", provider: "devin", session: "s",
      artifacts: Array.from({ length: 11 }, (_, i) => ({ externalId: `${batch}-${i}`, kind: "tool-result", locator: `native:${batch}-${i}` })) });
    const first = migration(store, { operation: "artifact-search" }) as { artifacts: { id: string }[]; nextOffset: number };
    assert.equal(first.artifacts.length, 20);
    const second = migration(store, { operation: "artifact-search", offset: first.nextOffset }) as { artifacts: unknown[]; nextOffset: null };
    assert.equal(second.artifacts.length, 2);
    assert.equal(second.nextOffset, null);
    const artifact = migration(store, { operation: "artifact-get", artifactId: first.artifacts[0].id }) as { content: null };
    assert.equal(artifact.content, null);
  } finally { store.close(); }
});
