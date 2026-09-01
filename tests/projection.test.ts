/**
 * LadybugDB projection: the mainframe-mini graph materialized as Cypher-
 * queryable tables. The projection is derived and regenerable; the SQLite
 * store remains the system of record.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { buildProjection, queryProjection, tableName } from "../src/project/ladybug.ts";
import { Store } from "../src/store/store.ts";
import { buildLock, defineProfile } from "../src/profile/define.ts";
import { t } from "../src/profile/schema.ts";

const fixture = join(import.meta.dirname, "..", "examples", "mainframe-mini");
let stateDir: string;
const overrides = () => ({ state: stateDir });
const projectionPath = () => join(stateDir, "projection.lbug");

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "trestle-proj-"));
});
after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

test("tableName maps kinds to Cypher-safe identifiers", () => {
  assert.equal(tableName("JavaClass"), "JavaClass");
  assert.equal(tableName("service-defined"), "service_defined");
});

test("project build + Cypher queries over the mainframe graph", async (t) => {
  await runCli(["profile", "build"], fixture, overrides());
  await runCli(["extract"], fixture, overrides());
  await runCli(["resolve"], fixture, overrides());
  await runCli(["project", "build"], fixture, overrides());
  assert.ok(existsSync(projectionPath()), "projection database created");

  await t.test("node counts match the store", async () => {
    const rows = await queryProjection(projectionPath(), `MATCH (n:Program) RETURN COUNT(*) AS c`);
    assert.equal(Number(rows[0]!.c), 3); // ACCT01, ACCT02, stub ACCT9M
  });

  await t.test("the signature READS edge is traversable with properties", async () => {
    const rows = await queryProjection(
      projectionPath(),
      `MATCH (p:Program)-[r:READS]->(d:Dataset)
       RETURN p.name AS program, d.name AS dataset, r.executionContext AS ctx,
              r.confidence AS confidence, r.evidenceCount AS evidence`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.program, "ACCT01");
    assert.equal(rows[0]!.dataset, "PROD.INVOICE.MASTER");
    assert.equal(rows[0]!.ctx, "DAILYINV.STEP030");
    assert.equal(rows[0]!.confidence, 0.95);
    assert.equal(Number(rows[0]!.evidence), 2); // COBOL + JCL sides
  });

  await t.test("stub provenance is queryable", async () => {
    const rows = await queryProjection(
      projectionPath(),
      `MATCH (p:Program) WHERE p.provenance = "stub" RETURN p.name AS name`,
    );
    assert.deepEqual(rows.map((r) => r.name), ["ACCT9M"]);
  });

  await t.test("multi-hop traversal: job -> program -> dataset", async () => {
    const rows = await queryProjection(
      projectionPath(),
      `MATCH (j:Job)-[:EXECUTES]->(p:Program)-[:READS|WRITES]->(d:Dataset)
       RETURN j.name AS job, p.name AS program, d.name AS dataset ORDER BY dataset`,
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.job, "DAILYINV");
    assert.deepEqual(rows.map((r) => r.dataset), ["PROD.INVOICE.MASTER", "PROD.INVOICE.REPORT"]);
  });

  await t.test("rebuild is idempotent (regenerable projection)", async () => {
    await runCli(["project", "build"], fixture, overrides());
    const rows = await queryProjection(projectionPath(), `MATCH (n) RETURN COUNT(*) AS c`);
    assert.equal(Number(rows[0]!.c), 6);
  });
});

test("reserved-word kinds and props survive projection (identifier quoting)", async () => {
  // Real collisions from dogfood runs: node kind "Table", props "group"
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
