import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/serve.ts";
import { loadConfig } from "../src/cli/config.ts";

test("HTTP boundaries reject malformed JSON shapes without losing valid batch responses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-boundary-"));
  const server = await startServer({
    dbPath: join(dir, "store.db"),
    projectionPath: join(dir, "projection.lbug"),
    lockPath: join(dir, "profile.lock.json"),
  }, { port: 0 });
  try {
    for (const body of [null, [], { query: 1 }, { query: " " }]) {
      const response = await fetch(`http://127.0.0.1:${server.port}/api/query`, {
        method: "POST", body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "query must be a non-empty string" });
    }
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      body: JSON.stringify([
        null,
        { jsonrpc: "2.0", id: {}, method: "ping" },
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "survey", arguments: [] } },
        { jsonrpc: "2.0", id: 2, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), [
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC 2.0 message" } },
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC 2.0 message" } },
      { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "tool arguments must be an object" } },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config boundary rejects malformed paths and visualization styles", async () => {
  for (const value of [
    { state: 42 },
    { corpusRoots: [1] },
    { visualization: [] },
    { visualization: { nodes: { Module: [] } } },
    { visualization: { edges: { CALLS: [] } } },
    { visualization: { nodes: { Module: { size: "large" } } } },
    { visualization: { edges: { CALLS: { hidden: "yes" } } } },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "trestle-config-"));
    try {
      writeFileSync(join(dir, "trestle.config.ts"), `export default ${JSON.stringify(value)};`);
      await assert.rejects(loadConfig(dir), /invalid Trestle configuration/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("config boundary preserves valid styles, defaults and path overrides", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-config-"));
  const visualization = {
    title: "Map",
    nodes: { Module: { label: "name", color: "red", size: 2, hidden: false } },
    edges: { CALLS: { width: 3, color: "blue", hidden: true } },
  };
  try {
    writeFileSync(join(dir, "trestle.config.ts"), `export default ${JSON.stringify({ visualization })};`);
    const config = await loadConfig(dir, { state: "custom-state" });
    assert.deepEqual(config.visualization, visualization);
    assert.equal(config.stateDir, join(dir, "custom-state"));
    assert.deepEqual(config.corpusRoots, [join(dir, "corpora")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
