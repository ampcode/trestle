/**
 * `trestle serve`: the MCP endpoint other threads attach through the orb
 * portal. Exercises the JSON-RPC lifecycle (initialize, tools/list,
 * tools/call), notifications, batches, and errors against the
 * mainframe-mini graph.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { startServer, type RunningServer } from "../src/server/serve.ts";

const fixture = join(import.meta.dirname, "..", "examples", "mainframe-mini", "trestle");
let stateDir: string;
let running: RunningServer;

const rpc = async (body: unknown): Promise<{ status: number; json: unknown }> => {
  const res = await fetch(`http://127.0.0.1:${running.port}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text === "" ? undefined : JSON.parse(text) };
};

const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  const { json } = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const result = (json as { result: { content: { text: string }[]; isError: boolean } }).result;
  return { text: result.content[0]!.text, isError: result.isError };
};

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "trestle-serve-"));
  const overrides = { state: stateDir };
  await runCli(["profile", "build"], fixture, overrides);
  await runCli(["extract"], fixture, overrides);
  await runCli(["resolve"], fixture, overrides);
  await runCli(["project", "build"], fixture, overrides);
  running = await startServer(
    {
      dbPath: join(stateDir, "trestle.db"),
      projectionPath: join(stateDir, "projection.lbug"),
      lockPath: join(fixture, "profile.lock.json"),
    },
    { port: 0 },
  );
});
after(async () => {
  await running.close();
  rmSync(stateDir, { recursive: true, force: true });
});

test("health endpoint", async () => {
  const res = await fetch(`http://127.0.0.1:${running.port}/health`);
  assert.equal(res.status, 200);
});

test("initialize negotiates protocol and advertises tools", async () => {
  const { status, json } = await rpc({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } },
  });
  assert.equal(status, 200);
  const result = (json as { result: Record<string, unknown> }).result;
  assert.equal(result.protocolVersion, "2025-03-26");
  assert.deepEqual(result.capabilities, { tools: {} });

  const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const tools = (list.json as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assert.deepEqual(tools.sort(), ["doctor", "graph_query", "status", "survey"]);
});

test("notifications get 202 and no body", async () => {
  const { status, json } = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(status, 202);
  assert.equal(json, undefined);
});

test("graph_query runs Cypher against the projection", async () => {
  const { text, isError } = await call("graph_query", {
    cypher: `MATCH (p:Program) RETURN p.name AS name ORDER BY name`,
  });
  assert.equal(isError, false);
  const rows = JSON.parse(text) as { name: string }[];
  assert.deepEqual(
    rows.map((r) => r.name),
    ["ACCT01", "ACCT02", "ACCT9M"],
  );
});

test("survey and status read the store per request", async () => {
  const survey = await call("survey");
  assert.equal(survey.isError, false);
  assert.match(survey.text, /facts \(live\)/);

  const status = await call("status");
  assert.equal(status.isError, false);
  const parsed = JSON.parse(status.text) as { nodes: number; edges: number };
  assert.equal(parsed.nodes, 6);
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
  assert.equal((unknown.json as { error: { code: number } }).error.code, -32601);

  const badTool = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "nope" } });
  assert.equal((badTool.json as { error: { code: number } }).error.code, -32602);

  const res = await fetch(`http://127.0.0.1:${running.port}/`, {
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
  assert.equal((batch.json as unknown[]).length, 2); // notification excluded
});
