/**
 * The thin-slice milestone from EXTRACT-RESOLVE §5: one artifact pair
 * through the full pipe — ACCT01/DAILYINV landing as
 * `Program ─READS→ Dataset` with two-file evidence.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { Store } from "../src/store/store.ts";

const fixture = join(import.meta.dirname, "..", "examples", "mainframe-mini");
let stateDir: string;
const overrides = () => ({ state: stateDir });

before(() => {
  stateDir = mkdtempSync(join(tmpdir(), "trestle-e2e-"));
});
after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

test("profile build + extract + resolve + survey", async (t) => {
  await runCli(["profile", "build"], fixture, overrides());
  await runCli(["extract"], fixture, overrides());
  await runCli(["resolve"], fixture, overrides());
  await runCli(["survey"], fixture, overrides());
  await runCli(["status"], fixture, overrides());

  const store = new Store(join(stateDir, "trestle.db"));
  t.after(() => store.close());

  await t.test("facts transcribed", () => {
    const counts = Object.fromEntries(store.factCounts().map((c) => [c.kind, c.count]));
    assert.deepEqual(counts, {
      "binding-observed": 5, // 3 file-control + 2 dd cards
      "unit-defined": 3, // ACCT01, ACCT02, DAILYINV
      "call-observed": 1,
      "execution-observed": 1,
    });
  });

  await t.test("nodes: declared + auto-vivified stubs", () => {
    const nodes = store.liveNodes();
    const byKey = new Map(nodes.map((n) => [`${n.kind}:${Object.values(n.identity)[0]}`, n]));
    assert.equal(byKey.get("Program:ACCT01")?.provenance, "declared");
    assert.equal(byKey.get("Program:ACCT02")?.provenance, "declared");
    assert.equal(byKey.get("Program:ACCT9M")?.provenance, "stub"); // CALL target, no source
    assert.equal(byKey.get("Job:DAILYINV")?.provenance, "declared");
    assert.equal(byKey.get("Dataset:PROD.INVOICE.MASTER")?.provenance, "stub");
    assert.equal(byKey.get("Dataset:PROD.INVOICE.REPORT")?.provenance, "stub");
    assert.equal(nodes.length, 6);
  });

  await t.test("the signature join: READS with two-sided evidence", () => {
    const reads = store.liveEdges("READS");
    assert.equal(reads.length, 1);
    const edge = reads[0]!;
    assert.deepEqual(edge.identity, { executionContext: "DAILYINV.STEP030" });
    assert.equal(edge.props.ddName, "INVDD");

    const evidence = store.liveEvidenceFor(edge.stableId);
    assert.equal(evidence.length, 2); // COBOL file-control + JCL DD card
    const paths = evidence.map((e) => e.source_path).sort();
    assert.deepEqual(paths, ["ACCT01.cbl", "DAILYINV.jcl"]);
    assert.ok(evidence.every((e) => e.resolver === "dd-resolution"));
    assert.ok(evidence.every((e) => e.confidence === 0.95));
    assert.ok(evidence.every((e) => e.rule === "open-input"));
  });

  await t.test("WRITES, EXECUTES, CALLS edges", () => {
    assert.equal(store.liveEdges("WRITES").length, 1);
    assert.equal(store.liveEdges("EXECUTES").length, 1);
    const calls = store.liveEdges("CALLS");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.props.callType, "static");
  });

  await t.test("unmatched reference became a claim", () => {
    const claims = store.openClaims("dd-unbound");
    assert.equal(claims.length, 1);
    assert.match(claims[0]!.detail as string, /ORPHDD.*ACCT02/);
  });
});

test("resolve is idempotent (provenance-scoped retirement)", async () => {
  const countLive = (store: Store) => ({
    nodes: store.liveNodes().length,
    edges: store.liveEdges().length,
    claims: store.openClaims().length,
  });
  const s1 = new Store(join(stateDir, "trestle.db"));
  const before1 = countLive(s1);
  s1.close();

  await runCli(["resolve"], fixture, overrides());

  const s2 = new Store(join(stateDir, "trestle.db"));
  const after1 = countLive(s2);
  const readsEvidence = s2.liveEvidenceFor(s2.liveEdges("READS")[0]!.stableId);
  s2.close();

  assert.deepEqual(after1, before1);
  assert.equal(readsEvidence.length, 2); // replaced, not accumulated
});

test("extract is incremental (memo cells skip unchanged inputs)", async () => {
  const s1 = new Store(join(stateDir, "trestle.db"));
  const totalRows = () => (s1.db.prepare(`SELECT COUNT(*) AS c FROM facts`).get() as { c: number }).c;
  const rowsBefore = totalRows();
  s1.close();

  await runCli(["extract"], fixture, overrides());

  const s2 = new Store(join(stateDir, "trestle.db"));
  const rowsAfter = (s2.db.prepare(`SELECT COUNT(*) AS c FROM facts`).get() as { c: number }).c;
  const liveAfter = (s2.db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE retired_rev IS NULL`).get() as { c: number }).c;
  s2.close();

  assert.equal(rowsAfter, rowsBefore); // no cell recomputed -> no new fact rows
  assert.equal(liveAfter, 10);
});
