/**
 * `trestle serve`: the MCP endpoint other threads attach through the orb
 * portal. Exercises the JSON-RPC lifecycle (initialize, tools/list,
 * tools/call), notifications, batches, and errors against the test
 * fixture graph.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { startServer, type RunningServer } from "../src/server/serve.ts";
import { isBoolean, isNumber, isProperties, isString, type JsonValue, type Properties } from "../src/profile/value.ts";
import { buildFixture, FIXTURE } from "./fixture.ts";

let repo: string;
let stateDir: string;
let running: RunningServer;

function expectObject(value: JsonValue): Properties {
  assert.ok(isProperties(value), "expected a JSON object");
  return value;
}

function expectArray(value: JsonValue): JsonValue[] {
  assert.ok(Array.isArray(value), "expected a JSON array");
  return value;
}

const rpc = async (body: JsonValue): Promise<{ status: number; json: JsonValue }> => {
  const res = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
};

const call = async (name: string, args: Properties = {}): Promise<{ text: string; isError: boolean }> => {
  const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = expectObject(expectObject(json).result);
  const text = expectObject(expectArray(result.content)[0]).text;
  assert.ok(isString(text));
  assert.ok(isBoolean(result.isError));
  return { text, isError: result.isError };
};

before(async () => {
  ({ repo, state: stateDir } = await buildFixture("serve"));
  await runCli(["project", "build"], repo, { state: stateDir });
  running = await startServer(
    {
      dbPath: join(stateDir, "trestle.db"),
      projectionPath: join(stateDir, "projection.lbug"),
      lockPath: join(repo, "profile.lock.json"),
      visualization: {
        title: "Fixture map",
        nodes: { Module: { label: "name", color: "#123456" } },
      },
    },
    { port: 0 },
  );
});
after(async () => {
  await running.close();
  rmSync(repo, { recursive: true, force: true });
});

test("health endpoint", async () => {
  const res = await fetch(`http://127.0.0.1:${running.port}/health`);
  assert.equal(res.status, 200);
});

test("serves G6VP and the live graph API", async () => {
  const root = await fetch(`http://127.0.0.1:${running.port}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type") ?? "", /text\/html/);
  const html = await root.text();
  assert.match(html, /Knowledge graph/);

  const scriptPath = /src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1];
  assert.ok(scriptPath, "missing G6VP application bundle");
  const application = await fetch(`http://127.0.0.1:${running.port}${scriptPath}`);
  assert.equal(application.status, 200);
  const applicationSource = await application.text();
  assert.ok(applicationSource.length > 1_000_000, "serves the G6VP application");
  assert.match(applicationSource, /GI_SDK_VERSION/);
  // Preload hints must follow the icon set used by the pinned SDK bundle.
  assert.match(applicationSource, /font_3381398_i824ocozt7/);
  assert.equal(application.headers.get("link"), null);

  const icons = "https://at.alicdn.com/t/a/font_3381398_i824ocozt7";
  assert.deepEqual(root.headers.get("link")?.split(", "), [
    "</api/graph>; rel=preload; as=fetch; crossorigin",
    `<${icons}.js>; rel=preload; as=script`,
    `<${icons}.json>; rel=preload; as=fetch; crossorigin`,
    ...["woff2", "woff", "ttf"].map(ext => `<${icons}.${ext}>; rel=preload; as=font; crossorigin`),
  ]);

  const response = await fetch(`http://127.0.0.1:${running.port}/api/graph`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("link"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const graph = await response.json();
  assert.ok(isProperties(graph));
  assert.equal(graph.initialized, true);
  const config = expectObject(graph.config);
  assert.equal(config.title, "Fixture map");
  assert.equal(expectObject(expectObject(config.nodes).Module).color, "#123456");
  const stats = expectObject(graph.stats);
  assert.equal(stats.nodes, FIXTURE.nodes);
  assert.ok(isNumber(stats.edges) && stats.edges > 0);
  assert.ok(expectArray(graph.nodes).some((value) => {
    const node = expectObject(value);
    return node.kind === "Module" && node.label === "A";
  }));
  assert.ok(expectArray(graph.edges).every((value) => {
    const edge = expectObject(value);
    return isNumber(edge.evidenceCount) && edge.evidenceCount > 0;
  }));
});

test("visualization API can run Cypher against the projection", async () => {
  const response = await fetch(`http://127.0.0.1:${running.port}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "MATCH (m:Module) RETURN m.name AS name ORDER BY name" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), FIXTURE.modules.map((name) => ({ name })));
});

test("MCP is exposed only at /mcp", async () => {
  const rootPost = await fetch(`http://127.0.0.1:${running.port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
  });
  assert.equal(rootPost.status, 404);
  const ping = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(ping.status, 200);
});

test("starts before the profile exists and reports an initialization state", async () => {
  const emptyDir = mkdtempSync(join(tmpdir(), "trestle-empty-serve-"));
  const emptyServer = await startServer(
    {
      dbPath: join(emptyDir, "trestle.db"),
      projectionPath: join(emptyDir, "projection.lbug"),
      lockPath: join(emptyDir, "missing.lock.json"),
      visualization: { title: "Empty graph" },
    },
    { port: 0 },
  );
  try {
    const response = await fetch(`http://127.0.0.1:${emptyServer.port}/api/graph`);
    assert.equal(response.status, 200);
    const graph = await response.json();
    assert.ok(isProperties(graph));
    assert.equal(graph.initialized, false);
    assert.deepEqual(graph.nodes, []);
    assert.equal(expectObject(graph.config).title, "Empty graph");
  } finally {
    await emptyServer.close();
    rmSync(emptyDir, { recursive: true, force: true });
  }
});

test("initialize negotiates protocol and advertises tools", async () => {
  const { status, json } = await rpc({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(status, 200);
  const result = expectObject(expectObject(json).result);
  assert.equal(result.protocolVersion, "2025-03-26");
  assert.deepEqual(result.capabilities, { tools: {} });

  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = expectArray(expectObject(expectObject(list.json).result).tools).map((t) => expectObject(t).name);
  assert.deepEqual(tools.sort(), ["doctor", "graph_query", "migration", "status", "survey"]);
});

test("migration MCP records a mandatory lead and rejects missing leads", async () => {
  const input = { operation: "create", id: "mcp-unit", title: "Migration", objective: "Separate module",
    acceptance: "Tests pass", scope: [], sourceRevision: "pinned-source", provider: "codex" };
  const rejected = await call("migration", input);
  assert.equal(rejected.isError, true);
  assert.match(rejected.text, /session/);
  const created = await call("migration", { ...input, session: "native-session" });
  assert.equal(created.isError, false);
  assert.equal(JSON.parse(created.text).lead_session, "native-session");
  const found = await call("migration", { operation: "get", id: "mcp-unit" });
  assert.equal(JSON.parse(found.text).lead_provider, "codex");
  const imported = await call("migration", { operation: "artifact-import", provider: "codex", session: "native-session",
    artifacts: [{ externalId: "verification", kind: "test-output", locator: "native:verification", content: "17 tests passed" }] });
  assert.equal(imported.isError, false);
  const artifactId = JSON.parse(imported.text)[0].id;
  const bookmarked = await call("migration", { operation: "bookmark", id: "mcp-unit", artifactId, kind: "verification", description: "Test output" });
  assert.equal(bookmarked.isError, false);
  const bookmarkId = JSON.parse(bookmarked.text).bookmarks[0].id;
  const evidence = await call("migration", { operation: "bookmark-get", bookmarkId });
  assert.equal(JSON.parse(evidence.text).artifact.content, "17 tests passed");
  const search = await call("migration", { operation: "artifact-search", provider: "codex", query: "17 tests" });
  assert.equal(JSON.parse(search.text).artifacts[0].id, artifactId);
});

test("notifications get 202 and no body", async () => {
  const { status, json } = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(status, 202);
  assert.equal(json, undefined);
});

test("graph_query runs Cypher against the projection", async () => {
  const { text, isError } = await call("graph_query", {
    cypher: `MATCH (m:Module) RETURN m.name AS name ORDER BY name`,
  });
  assert.equal(isError, false);
  const rows = expectArray(JSON.parse(text));
  assert.deepEqual(
    rows.map((r) => expectObject(r).name),
    FIXTURE.modules,
  );
});

test("survey and status read the store per request", async () => {
  const survey = await call("survey");
  assert.equal(survey.isError, false);
  assert.match(survey.text, /facts \(live\)/);

  const status = await call("status");
  assert.equal(status.isError, false);
  const parsed = expectObject(JSON.parse(status.text));
  assert.equal(parsed.nodes, FIXTURE.nodes);
});

test("tool failures are in-band isError results", async () => {
  const bad = await call("graph_query", { cypher: "MATCH syntax error!!!" });
  assert.equal(bad.isError, true);
  const missing = await call("graph_query", {});
  assert.equal(missing.isError, true);
  assert.match(missing.text, /requires a cypher string/);
});

test("protocol errors: unknown method, unknown tool, parse error, batch", async () => {
  const unknown = await rpc({ jsonrpc: "2.0", id: 9, method: "no/such" });
  assert.equal(expectObject(expectObject(unknown.json).error).code, -32601);

  const badTool = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "nope" } });
  assert.equal(expectObject(expectObject(badTool.json).error).code, -32602);

  const res = await fetch(`http://127.0.0.1:${running.port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);

  const batch = await rpc([
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/whatever" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  assert.equal(batch.status, 200);
  assert.equal(expectArray(batch.json).length, 2); // notification excluded
});
