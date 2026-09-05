import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Amp adapter binds invocation identity and bookmarks existing full-history messages", async () => {
  // Plugins are loaded by Amp, outside the engine's TypeScript compilation boundary.
  const pluginURL = new URL("../.amp/plugins/trestle.ts", import.meta.url).href;
  const plugin = await import(pluginURL);
  const messages = Array.from({ length: 21 }, (_, id) => ({ id, role: "assistant", content: [
    { type: "text", text: "Private transcript" }, { type: "thinking", thinking: "Private reasoning" },
    { type: "tool_use", name: "shell_command" },
  ] }));
  const ctx = { thread: { id: "T-current", async messages(options: { full: boolean; from: string; offset: number; limit: number }) {
    assert.equal(options.full, true);
    assert.equal(options.from, "start");
    return messages.slice(options.offset, options.offset + options.limit);
  } } };
  type Tool = { name: string; execute(input: Record<string, unknown>, context: typeof ctx): Promise<string> };
  const tools: Tool[] = [];
  plugin.default({ registerTool(tool: Tool) { tools.push(tool); } });
  const tool = tools.find(t => t.name === "trestle_amp")!;
  const dir = mkdtempSync(join(tmpdir(), "trestle-adapter-"));
  const oldDir = process.env.TRESTLE_COOKIE_DIR;
  const oldFetch = globalThis.fetch;
  try {
    process.env.TRESTLE_COOKIE_DIR = dir;
    const portal = "https://test.example";
    const hash = createHash("sha256").update("test.example").digest("hex").slice(0, 16);
    writeFileSync(join(dir, `portal-${hash}.json`), JSON.stringify({ cookies: ["test=fake"], expiresAt: null }));
    let sent: Record<string, unknown> = {};
    let imported: Record<string, unknown>[] = [];
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.params.name, "migration");
      sent = body.params.arguments;
      if (sent.operation === "artifact-import") {
        imported = sent.artifacts as Record<string, unknown>[];
        return Response.json({ result: { content: [{ text: JSON.stringify(imported.map((_, i) => ({ id: `artifact-${i}` }))) }] } });
      }
      return Response.json({ result: { content: [{ text: "recorded" }] } });
    };
    const indexText = await tool.execute({ operation: "index" }, ctx);
    const index = JSON.parse(indexText);
    assert.equal(index.nextOffset, 20);
    assert.deepEqual(index.messages[0], { id: 0, role: "assistant", tools: ["shell_command"] });
    assert.doesNotMatch(indexText, /Private/);
    assert.equal(calls, 0);
    await tool.execute({ operation: "create", id: "unit", portal_url: portal,
      arguments: { provider: "fake", session: "T-other", operation: "handoff" } }, ctx);
    assert.equal(sent.provider, "amp");
    assert.equal(sent.session, "T-current");
    assert.equal(sent.operation, "create");
    await tool.execute({ operation: "bookmark", id: "unit", message_id: 20, portal_url: portal,
      arguments: { kind: "decision", description: "Boundary decision", locator: "forged" } }, ctx);
    assert.deepEqual(JSON.parse(String(imported[0].locator)), { threadURL: "https://ampcode.com/threads/T-current", messageID: 20 });
    assert.equal(sent.artifactId, "artifact-0");
    assert.equal(imported[0].content, undefined);
    assert.equal(calls, 3);
    await assert.rejects(tool.execute({ operation: "bookmark", message_id: "missing" }, ctx), /not found/);
    assert.equal(calls, 3);
    await tool.execute({ operation: "handoff", id: "unit", message_id: 0, portal_url: portal,
      arguments: { revision: 2, description: "Handoff" } }, ctx);
    assert.equal(sent.revision, 2);
    assert.equal(sent.session, "T-current");
    assert.equal(JSON.parse(String(imported[0].locator)).messageID, 0);
    await tool.execute({ operation: "index", offset: 20, persist: true, capture_text: true, portal_url: portal }, ctx);
    assert.equal(imported[0].content, "Private transcript");
    assert.doesNotMatch(JSON.stringify(imported), /Private reasoning/);
    await assert.rejects(tool.execute({ operation: "index", capture_text: true }, ctx), /requires persist/);
    await assert.rejects(tool.execute({ operation: "index", offset: -1 }, ctx), /offset/);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDir === undefined) delete process.env.TRESTLE_COOKIE_DIR;
    else process.env.TRESTLE_COOKIE_DIR = oldDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
