import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.ts";
import { buildLock, defineProfile } from "../src/profile/define.ts";
import { t } from "../src/profile/schema.ts";
import type { Properties } from "../src/profile/value.ts";
import type { Directive } from "../src/resolve/directives.ts";
import { pipeline } from "../src/extract/pipeline.ts";
import { runExtraction } from "../src/extract/run.ts";

const profile = defineProfile({
  nodes: { Item: { identity: ["name"], props: { label: t.string().optional(), extra: t.string().optional() } } },
  edges: { LINK: { from: ["Item"], to: ["Item"], props: { label: t.string().optional(), extra: t.string().optional() } } },
  facts: { seen: { version: 1 } },
});
const hash = buildLock(profile).hash;
const node = (props: Properties = {}, name = "A"): Directive => ({ op: "node", kind: "Item", identity: { name }, props });
const edge = (props: Properties = {}, from = "A"): Extract<Directive, { op: "edge" }> => ({
  op: "edge", kind: "LINK", from: `Item:${from}`, to: "Item:B", props, evidence: [{ sourcePath: "source" }],
});

function env() {
  const dir = mkdtempSync(join(tmpdir(), "trestle-store-"));
  const path = join(dir, "store.db");
  const store = new Store(path);
  store.activateProfile(profile, hash);
  return { dir, path, store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("shared edges and evidence-free declarations survive abandoning or rerunning another owner", () => {
  const e = env();
  try {
    for (const owner of ["first", "second"]) e.store.applyDirectives(owner, "1", [node(), edge()]);
    const stable = e.store.liveEdges()[0].stableId;
    assert.equal(e.store.liveEvidenceFor(stable).length, 2);
    e.store.retireAbandonedOwners(["second"]);
    assert.equal(e.store.liveEdges().length, 1);
    assert.equal(e.store.liveEdges()[0].owner, "second");
    assert.equal(e.store.liveNodes().find(n => n.identity.name === "A")?.provenance, "declared");
    assert.deepEqual(e.store.liveEvidenceFor(stable).map(ev => ev.resolver), ["second"]);
    assert.deepEqual(e.store.retireAbandonedOwners(["second"]), { retired: 0, owners: [] });
    e.store.applyDirectives("first", "1", [node(), edge()]);
    e.store.applyDirectives("second", "2", []);
    assert.equal(e.store.liveEdges().length, 1);
    assert.equal(e.store.liveNodes().find(n => n.identity.name === "A")?.provenance, "declared");
    e.store.applyDirectives("first", "2", []);
    assert.deepEqual(e.store.liveEdges(), []);
    assert.deepEqual(e.store.liveNodes(), []);
  } finally { e.close(); }
});

test("node and edge property contributions retract without removing another resolver's enrichment", () => {
  const e = env();
  try {
    e.store.applyDirectives("first", "1", [node({ label: "old" }), edge({ label: "old" })]);
    e.store.applyDirectives("second", "1", [node({ extra: "kept" }), edge({ extra: "kept" })]);
    e.store.applyDirectives("first", "2", [node(), edge()]);
    assert.deepEqual(e.store.liveNodes().find(n => n.identity.name === "A")?.props, { extra: "kept" });
    assert.deepEqual(e.store.liveEdges()[0].props, { extra: "kept" });
    e.store.applyDirectives("first", "3", [node({ extra: "kept" }), edge({ extra: "kept" })]);
    e.store.retireAbandonedOwners(["first"]);
    assert.deepEqual(e.store.liveEdges()[0].props, { extra: "kept" });
    e.store.applyDirectives("first", "4", [edge()]);
    const a = e.store.liveNodes().find(n => n.identity.name === "A");
    assert.equal(a?.provenance, "stub");
    assert.deepEqual(a?.props, {});
    assert.deepEqual(e.store.liveEdges()[0].props, {});
  } finally { e.close(); }
});

test("conflicting contributions fail atomically, including repeated declarations in one batch", () => {
  const e = env();
  try {
    e.store.applyDirectives("first", "1", [node({ label: "old" }), edge({ label: "old" })]);
    e.store.applyDirectives("second", "1", [node({ extra: "kept" }), edge({ extra: "kept" })]);
    const generation = e.store.currentGeneration();
    const nodes = e.store.liveNodes();
    const edges = e.store.liveEdges();
    const evidence = e.store.liveEvidenceFor(edges[0].stableId);
    for (const directives of [
      [node({ label: "new" })], [edge({ label: "new" })],
      [node({ extra: "a" }), node({ extra: "b" })],
      [edge({ extra: "a" }), edge({ extra: "b" })],
    ]) {
      assert.throws(() => e.store.applyDirectives("second", "2", directives), /conflicting (node|edge) property/);
      assert.equal(e.store.currentGeneration(), generation);
      assert.deepEqual(e.store.liveNodes(), nodes);
      assert.deepEqual(e.store.liveEdges(), edges);
      assert.deepEqual(e.store.liveEvidenceFor(edges[0].stableId), evidence);
    }
    e.store.applyDirectives("first", "3", [node({ label: "new" }), node({ extra: "kept" }), edge({ label: "new" })]);
    assert.deepEqual(e.store.liveNodes().find(n => n.identity.name === "A")?.props, { label: "new", extra: "kept" });
  } finally { e.close(); }
});

test("generation is durable and transaction-local, not a revision or bookkeeping counter", () => {
  const e = env();
  const reader = new Store(e.path);
  try {
    const generation = e.store.currentGeneration();
    const rev = e.store.beginRevision("extract");
    e.store.recordArtifact("a", "hash", "corpus", rev);
    e.store.putMemoCell("cell", "hash", [], rev);
    e.store.activateProfile(profile, hash);
    assert.equal(e.store.currentGeneration(), generation);
    e.store.db.exec("BEGIN");
    e.store.insertFact({ kind: "seen", sourcePath: "a", props: {} }, "cell", rev);
    assert.ok(e.store.currentGeneration() > generation);
    assert.equal(reader.currentGeneration(), generation);
    assert.deepEqual(reader.factsByKind("seen"), []);
    e.store.db.exec("ROLLBACK");
    assert.equal(e.store.currentGeneration(), generation);
    reader.db.exec("BEGIN");
    assert.equal(reader.currentGeneration(), generation);
    e.store.insertFact({ kind: "seen", sourcePath: "a", props: {} }, "cell", rev);
    assert.equal(reader.currentGeneration(), generation);
    assert.deepEqual(reader.factsByKind("seen"), []);
    reader.db.exec("COMMIT");
    assert.equal(reader.currentGeneration(), e.store.currentGeneration());
    assert.equal(reader.factsByKind("seen").length, 1);
    const beforeFailure = e.store.currentGeneration();
    assert.throws(() => e.store.replaceFactsByCell("cell", [{ kind: "unknown", sourcePath: "a", props: {} }], rev));
    assert.equal(e.store.currentGeneration(), beforeFailure);
    assert.equal(reader.factsByKind("seen").length, 1);
    const reopened = new Store(e.path);
    try { assert.equal(reopened.currentGeneration(), beforeFailure); } finally { reopened.close(); }
  } finally { reader.close(); e.close(); }
});

test("evidence pagination detects memo replacement within a single extraction revision", async () => {
  const e = env();
  try {
    const opts = { corpusRoots: [], stateDir: e.dir, fingerprintSeed: "1" };
    const emitCell = pipeline(async ({ memo, emit }) => {
      await memo("cell", [], () => emit({ kind: "seen", sourcePath: "a", props: {} }));
    });
    await runExtraction(e.store, emitCell, opts);
    const factId = e.store.factsByKind("seen")[0].id;
    e.store.applyDirectives("links", "1", [{ ...edge(), evidence: [{ factId }, { factId }] }]);
    const stable = e.store.liveEdges()[0].stableId;
    const changed = pipeline(async ({ memo, emit }) => {
      const before = e.store.graphEvidence("edge", stable, 1);
      await memo("cell", [], () => emit({ kind: "seen", sourcePath: "a", props: {} }));
      const after = e.store.graphEvidence("edge", stable, 1, before.nextAfterId!);
      assert.equal(after.revision, before.revision);
      assert.ok(after.generation > before.generation);
      assert.equal(before.evidence[0].fact?.retiredRev, null);
      assert.equal(after.evidence[0].fact?.retiredRev, after.revision);
      assert.throws(() => e.store.graphEvidence("edge", stable, 1, before.nextAfterId!, before.generation), /generation changed/);
      assert.equal(e.store.graphEvidence("edge", stable).generation, after.generation);
    });
    await runExtraction(e.store, changed, { ...opts, fingerprintSeed: "2" });
    const generation = e.store.currentGeneration();
    const skipped = await runExtraction(e.store, emitCell, { ...opts, fingerprintSeed: "2" });
    assert.equal(skipped.cells.skipped, 1);
    assert.equal(e.store.currentGeneration(), generation);
  } finally { e.close(); }
});

test("resolver reruns preserve logical IDs and props but replace evidence and invalidate pages", () => {
  const e = env();
  try {
    e.store.applyDirectives("same", "1", [node(), edge()]);
    const nodes = e.store.liveNodes();
    const edges = e.store.liveEdges();
    const before = e.store.graphEvidence("edge", edges[0].stableId);
    e.store.applyDirectives("same", "1", [node(), edge()]);
    const after = e.store.graphEvidence("edge", edges[0].stableId);
    assert.deepEqual(e.store.liveNodes(), nodes);
    assert.deepEqual(e.store.liveEdges(), edges);
    assert.ok(after.generation > before.generation);
    assert.notEqual(after.evidence[0].id, before.evidence[0].id);
    e.store.applyDirectives("empty", "1", []);
    assert.equal(e.store.currentGeneration(), after.generation);
  } finally { e.close(); }
});

test("alias merges retain canonical identity, property precedence, evidence, and contribution ownership", () => {
  const e = env();
  try {
    e.store.applyDirectives("canonical", "1", [node({ label: "canonical" })]);
    e.store.applyDirectives("alias", "1", [node({ label: "alias", extra: "from alias" }, "Alias"), edge({}, "Alias")]);
    e.store.applyDirectives("shared", "1", [edge({}, "Alias")]);
    const generation = e.store.currentGeneration();
    e.store.applyDirectives("unify", "1", [{ op: "alias", canonical: "Item:A", alias: "Item:Alias" }]);
    assert.ok(e.store.currentGeneration() > generation);
    const a = e.store.liveNodeByStable(e.store.nodeStableId("Item", { name: "A" }));
    assert.deepEqual(a?.identity, { name: "A" });
    assert.deepEqual(a?.props, { label: "canonical", extra: "from alias" });
    assert.equal(e.store.liveNodeByStable(e.store.nodeStableId("Item", { name: "Alias" })), null);
    assert.equal(e.store.liveEdges()[0].fromStable, a?.stableId);
    assert.equal(e.store.liveEvidenceFor(e.store.liveEdges()[0].stableId).length, 2);
    e.store.retireAbandonedOwners(["canonical", "shared", "unify"]);
    assert.equal(e.store.liveEdges().length, 1);
    assert.deepEqual(e.store.liveNodes().find(n => n.identity.name === "A")?.props, { label: "canonical" });
  } finally { e.close(); }
});

test("profile guards follow the SQLite snapshot and reject a stale in-memory vocabulary", () => {
  const e = env();
  const other = new Store(e.path);
  try {
    e.store.db.exec("BEGIN");
    const generation = e.store.currentGeneration();
    const replacement = defineProfile({ nodes: {}, edges: {}, facts: {} });
    other.activateProfile(replacement, buildLock(replacement).hash);
    assert.equal(e.store.currentGeneration(), generation);
    assert.equal(e.store.requireProfile(), profile);
    e.store.db.exec("COMMIT");
    assert.ok(e.store.currentGeneration() > generation);
    assert.throws(() => e.store.requireProfile(), /active profile changed/);
    assert.throws(() => e.store.applyDirectives("stale", "1", [node()]), /active profile changed/);
    e.store.activateProfile(profile, hash);
    assert.equal(e.store.requireProfile(), profile);
  } finally { other.close(); e.close(); }
});

test("profile reactivation and direct authoritative SQL mutations advance generation", () => {
  const e = env();
  try {
    const other = defineProfile({ nodes: {}, edges: {}, facts: {} });
    const generation = e.store.currentGeneration();
    e.store.activateProfile(other, buildLock(other).hash);
    const changed = e.store.currentGeneration();
    assert.ok(changed > generation);
    e.store.activateProfile(profile, hash);
    assert.ok(e.store.currentGeneration() > changed);
    e.store.applyDirectives("r", "1", [node(), edge(), { op: "claim", kind: "unknown", detail: "test" }]);
    for (const sql of [
      "UPDATE nodes SET props = '{\"label\":\"sql\"}' WHERE retired_rev IS NULL",
      "UPDATE edges SET props = '{\"label\":\"sql\"}' WHERE retired_rev IS NULL",
      "UPDATE evidence SET note = 'changed' WHERE retired_rev IS NULL",
      "UPDATE claims SET status = 'closed' WHERE retired_rev IS NULL",
      "INSERT INTO decisions (decision, created_rev) VALUES ('accepted', 1)",
      "DELETE FROM decisions",
    ]) {
      const before = e.store.currentGeneration();
      e.store.db.exec(sql);
      assert.ok(e.store.currentGeneration() > before, sql);
    }
  } finally { e.close(); }
});

test("legacy ownership migration preserves shared evidence and is performed only once", () => {
  const e = env();
  try {
    e.store.applyDirectives("first", "1", [node({ label: "old" }), edge({ label: "old" })]);
    e.store.applyDirectives("second", "1", [edge()]);
    e.store.db.exec("DROP TABLE entity_contributions");
    const migrated = new Store(e.path);
    try {
      assert.deepEqual(migrated.liveEdges()[0].props, { label: "old" });
      migrated.retireAbandonedOwners(["second"]);
      assert.equal(migrated.liveEdges().length, 1);
      assert.equal(migrated.liveEvidenceFor(migrated.liveEdges()[0].stableId).length, 1);
      assert.deepEqual(migrated.liveEdges()[0].props, {});
      const generation = migrated.currentGeneration();
      const reopened = new Store(e.path);
      try { assert.equal(reopened.currentGeneration(), generation); } finally { reopened.close(); }
    } finally { migrated.close(); }
  } finally { e.close(); }
});
