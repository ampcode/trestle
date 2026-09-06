import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Coordination, callCoordination } from "../src/coordination/index.ts";

const messages = Array.from({ length: 21 }, (_, id) => ({ id, role: "assistant" as const, content: [
  { type: "text" as const, text: "Private transcript" },
  { type: "thinking" as const, thinking: "Private reasoning" },
  { type: "tool_use" as const, id: `tool-${id}`, name: "shell_command", input: { secret: true } },
] }));

test("Amp coordination adapter binds identity, protects content, and derives stable request IDs", async () => {
  const plugin = await import(new URL("../.amp/plugins/trestle.ts", import.meta.url).href);
  const ctx = { thread: { id: "T-current", async messages(options: { offset: number; limit: number }) {
    return messages.slice(options.offset, options.offset + options.limit);
  } } };
  type Tool = { name: string; execute(input: Record<string, unknown>, context: typeof ctx): Promise<string> };
  const tools: Tool[] = [];
  plugin.default({ registerTool(tool: Tool) { tools.push(tool); } });
  const tool = tools.find(tool => tool.name === "trestle_amp")!;
  const dir = mkdtempSync(join(tmpdir(), "trestle-adapter-"));
  const oldDir = process.env.TRESTLE_COOKIE_DIR;
  const oldFetch = globalThis.fetch;
  try {
    process.env.TRESTLE_COOKIE_DIR = dir;
    const portal = "https://test.example";
    const hash = createHash("sha256").update("test.example").digest("hex").slice(0, 16);
    writeFileSync(join(dir, `portal-${hash}.json`), JSON.stringify({ cookies: ["test=fake"], expiresAt: null }));
    const calls: Array<{ operation: string; arguments: Record<string, unknown>; requestId?: string }> = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.params.name, "coordination");
      calls.push(body.params.arguments);
      const operation = body.params.arguments.operation;
      const value = operation === "indexArtifacts" ? [{ id: "artifact-0" }]
        : operation === "createBookmark" ? { id: "bookmark-0" } : { ok: true };
      return Response.json({ result: { content: [{ text: JSON.stringify(value) }] } });
    };

    const index = JSON.parse(await tool.execute({ operation: "index" }, ctx));
    assert.equal(index.nextOffset, 20);
    assert.doesNotMatch(JSON.stringify(index), /Private/);
    assert.equal(calls.length, 0);
    await assert.rejects(tool.execute({ operation: "create", id: "unit" }, ctx), /request_id/);

    await tool.execute({ operation: "create", id: "unit", request_id: "req-1", portal_url: portal,
      arguments: { provider: "fake", sessionId: "T-forged", title: "Unit", objective: "Do it",
        acceptance: "done", scope: { graphRevision: 1, entityIds: [], sourceRevision: "abc" } } }, ctx);
    assert.deepEqual(calls.slice(0, 2).map(call => [call.operation, call.requestId]), [
      ["registerSession", "req-1:register"], ["createUnit", "req-1:create"],
    ]);
    assert.deepEqual((calls[0].arguments as { ref: unknown }).ref, { provider: "amp", sessionId: "T-current" });
    assert.deepEqual((calls[1].arguments as { lead: unknown }).lead, { provider: "amp", sessionId: "T-current" });
    assert.equal("provider" in calls[1].arguments, false);

    await tool.execute({ operation: "handoff", id: "unit", message_id: 20, request_id: "req-2", portal_url: portal,
      capture_text: false, arguments: { expectedRevision: 2, kind: "decision", description: "Handoff",
        ref: { provider: "fake", sessionId: "forged" } } }, ctx);
    const handoff = calls.slice(2);
    assert.deepEqual(handoff.map(call => [call.operation, call.requestId]), [
      ["registerSession", "req-2:register"], ["indexArtifacts", "req-2:index"],
      ["createBookmark", "req-2:bookmark"], ["handoffLead", "req-2:handoff"],
    ]);
    const indexed = (handoff[1].arguments.artifacts as Record<string, unknown>[])[0];
    assert.deepEqual(indexed.session, { provider: "amp", sessionId: "T-current" });
    assert.deepEqual(indexed.locator, { threadURL: "https://ampcode.com/threads/T-current", messageID: 20 });
    assert.equal(indexed.text, undefined);
    assert.doesNotMatch(JSON.stringify(indexed), /Private reasoning|secret/);
    assert.deepEqual(handoff[3].arguments.newLead, { provider: "amp", sessionId: "T-current" });
    assert.equal(handoff[3].arguments.bookmarkId, "bookmark-0");

    await tool.execute({ operation: "index", offset: 20, persist: true, capture_text: true,
      request_id: "req-3", portal_url: portal }, ctx);
    const visible = (calls.at(-1)!.arguments.artifacts as Record<string, unknown>[])[0];
    assert.equal(visible.text, "Private transcript");
    assert.doesNotMatch(JSON.stringify(visible), /Private reasoning|secret/);

    const db = new DatabaseSync(":memory:");
    try {
      const core = new Coordination(db, "adapter-test");
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const value = callCoordination(core, body.params.arguments);
        return Response.json({ result: { content: [{ text: JSON.stringify(value) }] } });
      };
      await tool.execute({ operation: "create", id: "integrated", request_id: "create", portal_url: portal,
        arguments: { title: "Unit", objective: "Do it", acceptance: "done",
          scope: { graphRevision: 1, entityIds: [], sourceRevision: "abc" } } }, ctx);
      const replacement = { thread: { ...ctx.thread, id: "T-next" } };
      const handoffInput = { operation: "handoff", id: "integrated", message_id: 20,
        request_id: "handoff", portal_url: portal, arguments: { expectedRevision: 1, description: "Continue here" } };
      const transferred = await tool.execute(handoffInput, replacement);
      assert.equal(await tool.execute(handoffInput, replacement), transferred);
      assert.equal(core.getUnit("integrated").lead.sessionId, "T-next");
      assert.equal(core.getSession({ provider: "amp", sessionId: "T-current" }).role, "contributor");
      assert.equal(core.getUnitHistory("integrated").items.length, 2);
      assert.equal(core.listBookmarks("integrated").items.length, 1);
      assert.equal(core.listBookmarks("integrated").items[0].kind, "handoff");
    } finally { db.close(); }

    rmSync(join(dir, `portal-${hash}.json`));
    globalThis.fetch = async () => Response.json({ result: { content: [{ text: '{"items":[]}' }] } });
    assert.deepEqual(JSON.parse(await tool.execute({ operation: "list", portal_url: portal }, ctx)), { items: [] });
    globalThis.fetch = async () => new Response("Authentication required", { status: 401 });
    assert.match(await tool.execute({ operation: "list", portal_url: portal }, ctx), /Mint a one-time login URL/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.TRESTLE_COOKIE_DIR;
    else process.env.TRESTLE_COOKIE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Amp connector reads only Amp refs and defaults to metadata-only history", async () => {
  const { createAmpConnector } = await import(new URL("../.amp/plugins/trestle.ts", import.meta.url).href);
  const thread = {
    id: "T-current", title: { async get() { return "Current"; } },
    state: { async get() { return "running" as const; } },
    async messages(options: { offset: number; limit: number }) { return messages.slice(options.offset, options.offset + options.limit); },
  };
  const connector = createAmpConnector({ threads: { get(id: string) { assert.equal(id, "T-current"); return thread; } } });
  assert.deepEqual(connector.capabilities, { activity: true, fullHistory: true, artifactContent: true });
  assert.equal((await connector.readSession({ provider: "other", sessionId: "T-current" })).unsupported, true);
  const session = await connector.readSession({ provider: "amp", sessionId: "T-current" });
  assert.equal(session.observation.state, "working");
  const history = await connector.readHistory({ provider: "amp", sessionId: "T-current" });
  assert.equal(history.nextCursor, "20");
  assert.equal(history.artifacts[0].text, undefined);
  assert.doesNotMatch(JSON.stringify(history), /Private reasoning|secret/);
});
