/**
 * LadybugDB projection: the fixture graph materialized as Cypher-queryable
 * tables. The projection is derived and regenerable; the SQLite
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
  assert.ok(existsSync(projectionPath()), "projection database created");

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
