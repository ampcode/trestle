/**
 * LadybugDB projection: the fixture graph materialized as Cypher-queryable
 * tables. The projection is derived and regenerable; the SQLite
 * store remains the system of record.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { buildProjection, queryProjection, queryProjectionWithMetadata, tableName } from "../src/project/ladybug.ts";
import { Store } from "../src/store/store.ts";
import { buildLock, defineProfile } from "../src/profile/define.ts";
import { t } from "../src/profile/schema.ts";
import { isProperties, isString, type JsonValue } from "../src/profile/value.ts";
import { buildFixture, FIXTURE } from "./fixture.ts";

let repo: string;
let stateDir: string;
const projectionPath = () => join(stateDir, "projection.lbug");

before(async () => {
  ({ repo, state: stateDir } = await buildFixture("proj"));
});
after(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("tableName maps kinds to Cypher-safe identifiers", () => {
  assert.equal(tableName("JavaClass"), "JavaClass");
  assert.equal(tableName("service-defined"), "service_defined");
});

test("project build + Cypher queries over the fixture graph", async (t) => {
  await runCli(["project", "build"], repo, { state: stateDir });
  assert.ok(existsSync(`${projectionPath()}.current.json`), "projection published");

  await t.test("node counts match the store", async () => {
    const rows = await queryProjection(projectionPath(), `MATCH (m:Module) RETURN COUNT(*) AS c`);
    assert.equal(Number(rows[0]!.c), FIXTURE.modules.length);
  });

  await t.test("the join edge is traversable with its props and two-sided evidence", async () => {
    const rows = await queryProjection(
      projectionPath(),
      `MATCH (m:Module)-[r:READS]->(res:Resource)
       RETURN m.name AS module, res.name AS resource, r.context AS ctx, r.evidenceCount AS evidence`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.module, "A");
    assert.equal(rows[0]!.resource, "ledger");
    assert.equal(rows[0]!.ctx, "nightly");
    assert.equal(Number(rows[0]!.evidence), 2);
  });

  await t.test("stub provenance is queryable", async () => {
    const rows = await queryProjection(projectionPath(), `MATCH (m:Module) WHERE m.provenance = "stub" RETURN m.name AS name`);
    assert.deepEqual(rows.map((r) => r.name), FIXTURE.stubs);
  });

  await t.test("multiple statement results are closed before rejecting the query", async () => {
    await assert.rejects(
      queryProjection(projectionPath(), "RETURN 1 AS first; RETURN 2 AS second"),
      /projection queries must contain one statement/,
    );
    const rows = await queryProjection(projectionPath(), "RETURN 3 AS value");
    assert.equal(Number(rows[0]!.value), 3);
  });

  await t.test("engine rejects mutations, including mutations in multi-statement input, without side effects", async () => {
    const mutation = 'MATCH (m:Module) WHERE m.name = "A" SET m.name = "MUTATED" RETURN m.name AS name';
    for (const cypher of [mutation, `${mutation}; RETURN 1`, `RETURN 1; ${mutation}`,
      'CREATE (:Module {stableId:"bad", name:"bad"})', 'MATCH (m:Module) DETACH DELETE m',
      'DROP TABLE Module', 'BEGIN TRANSACTION; MATCH (m:Module) SET m.name = "bad"; COMMIT']) {
      await assert.rejects(queryProjection(projectionPath(), cypher), /read.only|one statement/i);
      const rows = await queryProjection(projectionPath(), "MATCH (m:Module) RETURN m.name AS name ORDER BY name");
      assert.deepEqual(rows.map((row) => row.name), FIXTURE.modules);
    }
    const store = new Store(join(stateDir, "trestle.db"));
    try {
      assert.deepEqual(store.liveNodes("Module").map((node) => node.identity.name).sort(), FIXTURE.modules);
    } finally {
      store.close();
    }
  });

  await t.test("multi-hop traversal: caller -> callee -> resource", async () => {
    const rows = await queryProjection(
      projectionPath(),
      `MATCH (a:Module)-[:CALLS]->(b:Module), (a)-[:READS]->(res:Resource)
       RETURN a.name AS caller, b.name AS callee, res.name AS resource ORDER BY callee`,
    );
    assert.deepEqual(rows.map((r) => [r.caller, r.callee, r.resource]), [["A", "B", "ledger"], ["A", "Z", "ledger"]]);
  });

  await t.test("rebuild is idempotent (regenerable projection)", async () => {
    await runCli(["project", "build"], repo, { state: stateDir });
    const rows = await queryProjection(projectionPath(), `MATCH (n) RETURN COUNT(*) AS c`);
    assert.equal(Number(rows[0]!.c), FIXTURE.nodes);
  });
});

test("reserved-word kinds and props survive projection (identifier quoting)", async () => {
  // Real collisions seen in practice: node kind "Table", props "group"
  // and "table" are Cypher/Ladybug reserved words. The projection must
  // quote identifiers instead of forcing profile renames.
  const profile = defineProfile({
    nodes: { Table: { identity: ["name"], props: { group: t.string() } } },
    edges: { Order: { from: ["Table"], to: ["Table"], props: { table: t.string() } } },
    facts: {},
  });
  const dir = mkdtempSync(join(tmpdir(), "trestle-quote-"));
  const store = new Store(join(dir, "trestle.db"));
  try {
    store.activateProfile(profile, buildLock(profile).hash);
    store.applyDirectives("test-resolver", "0", [
      { op: "node", kind: "Table", identity: { name: "CUSTOMER" }, props: { group: "CORE" } },
      { op: "node", kind: "Table", identity: { name: "ORDERS" }, props: { group: "SALES" } },
      {
        op: "edge",
        kind: "Order",
        from: { kind: "Table", identity: { name: "CUSTOMER" } },
        to: { kind: "Table", identity: { name: "ORDERS" } },
        props: { table: "JOIN_T" },
        evidence: [{ sourcePath: "x.sql", locator: { line: 1 } }],
      },
    ]);
    const dbPath = join(dir, "projection.lbug");
    const r = await buildProjection(store, dbPath);
    assert.equal(r.nodes, 2);
    assert.equal(r.edges, 1);
    const rows = await queryProjection(
      dbPath,
      "MATCH (a:`Table`)-[r:`Order`]->(b:`Table`) RETURN a.`group` AS g, r.`table` AS t, b.name AS n",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.g, "CORE");
    assert.equal(rows[0]!.t, "JOIN_T");
    assert.equal(rows[0]!.n, "ORDERS");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("snapshot generation, failed rebuilds, competing builders, and readers across publication", async (context) => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-publication-"));
  const path = join(dir, "projection.lbug");
  const store = new Store(join(dir, "trestle.db"));
  const profile = defineProfile({ nodes: { Module: { identity: ["name"] } }, edges: {}, facts: {} });
  const query = "MATCH (m:Module) RETURN m.name AS name ORDER BY name";
  try {
    store.activateProfile(profile, buildLock(profile).hash);
    store.applyDirectives("test", "0", [{ op: "node", kind: "Module", identity: { name: "A" } }]);
    const first = await buildProjection(store, path);
    assert.equal(first.sourceGeneration, store.currentGeneration());
    const pointer = readFileSync(`${path}.current.json`, "utf8");
    const initial = await queryProjectionWithMetadata(path, query);
    assert.deepEqual(initial, { rows: [{ name: "A" }], sourceGeneration: first.sourceGeneration });

    const manifest: JsonValue = JSON.parse(pointer);
    assert.ok(isProperties(manifest) && isString(manifest.directory));
    const legacy = join(dir, "legacy.lbug");
    copyFileSync(join(dir, manifest.directory, "data.lbug"), legacy);
    assert.deepEqual(await queryProjectionWithMetadata(legacy, query), { rows: initial.rows, sourceGeneration: null });
    await assert.rejects(queryProjection(legacy, 'MATCH (m:Module) SET m.name = "bad"'), /read.only/i);
    await buildProjection(store, legacy);
    assert.ok(existsSync(legacy), "legacy database left untouched during upgrade");
    assert.deepEqual(await queryProjectionWithMetadata(legacy, query), initial);

    store.db.exec("BEGIN");
    try {
      await assert.rejects(buildProjection(store, path), /transaction/i);
      assert.equal(store.db.isTransaction, true, "caller transaction not rolled back");
    } finally {
      store.db.exec("ROLLBACK");
    }

    // Real DDL failure after opening a fresh database must not damage the old one.
    const invalid = defineProfile({ nodes: { Module: { identity: ["stableId"] } }, edges: {}, facts: {} });
    const badProfile = context.mock.method(store, "requireProfile", () => invalid);
    await assert.rejects(buildProjection(store, path), /stableId/i);
    badProfile.mock.restore();
    assert.equal(readFileSync(`${path}.current.json`, "utf8"), pointer);
    assert.deepEqual(await queryProjectionWithMetadata(path, query), initial);
    assert.equal(existsSync(`${path}.build-lock`), false);

    const { Connection } = await import("@ladybugdb/core");
    const close = Connection.prototype.close;
    const failedClose = context.mock.method(Connection.prototype, "close", async function (this: import("@ladybugdb/core").Connection) {
      await close.call(this);
      throw new Error("injected close failure");
    }, { times: 1 });
    try {
      await assert.rejects(buildProjection(store, path), /injected close failure/);
    } finally {
      failedClose.mock.restore();
    }
    assert.equal(readFileSync(`${path}.current.json`, "utf8"), pointer);
    assert.deepEqual(await queryProjectionWithMetadata(path, query), initial);

    // Pin the SQLite WAL snapshot by reading generation, then commit through a
    // second connection before reading nodes. The projected data must stay old.
    const writer = new Store(join(dir, "trestle.db"));
    writer.activateProfile(profile, buildLock(profile).hash);
    const liveNodes = store.liveNodes.bind(store);
    const interleave = context.mock.method(store, "liveNodes", () => {
      writer.applyDirectives("other", "0", [{ op: "node", kind: "Module", identity: { name: "B" } }]);
      return liveNodes();
    });
    try {
      const captured = await buildProjection(store, path);
      assert.equal(captured.sourceGeneration, first.sourceGeneration);
      assert.ok(writer.currentGeneration() > captured.sourceGeneration);
      assert.deepEqual(await queryProjectionWithMetadata(path, query), initial);
    } finally {
      interleave.mock.restore();
      writer.close();
    }

    // A separate process holds the previous generation open throughout rebuild.
    // No database rename/delete is allowed: it must still be readable afterwards.
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { Database, Connection } from '@ladybugdb/core';
      import { readFileSync } from 'node:fs';
      import { dirname, join } from 'node:path';
      const path = process.argv[1];
      const pointer = JSON.parse(readFileSync(path + '.current.json', 'utf8'));
      const db = new Database(join(dirname(path), pointer.directory, 'data.lbug'), 0, true, true);
      const conn = new Connection(db);
      const first = await conn.query('RETURN 1'); first.close();
      console.log('ready');
      process.stdin.once('data', async () => {
        const result = await conn.query('MATCH (m:Module) RETURN m.name AS name');
        console.log(JSON.stringify(await result.getAll()));
        result.close(); await conn.close(); await db.close(); process.stdin.destroy();
      });
    `, path], { cwd: join(import.meta.dirname, ".."), stdio: ["pipe", "pipe", "inherit"] });
    const exited = once(child, "exit");
    try {
      const [ready] = await once(child.stdout, "data");
      assert.match(String(ready), /ready/);
      const builds = await Promise.allSettled([buildProjection(store, path), buildProjection(store, path)]);
      assert.equal(builds.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = builds.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.match(String(rejected.reason), /build locked/);
      const reads = await Promise.all(Array.from({ length: 3 }, () => queryProjectionWithMetadata(path, query)));
      for (const read of reads) {
        assert.equal(read.sourceGeneration, store.currentGeneration());
        assert.deepEqual(read.rows, [{ name: "A" }, { name: "B" }]);
      }
      const output = once(child.stdout, "data");
      child.stdin.end("read\n");
      assert.deepEqual(JSON.parse(String((await output)[0])), [{ name: "A" }]);
    } finally {
      if (!child.stdin.destroyed) child.stdin.end("read\n");
      assert.equal((await exited)[0], 0);
    }
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
