/**
 * `trestle doctor`: the mechanical health checks must pass on a healthy
 * graph and each must fire on a fabricated pathology. Pathologies are
 * injected with raw SQL because the store's own API refuses to create them.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { Store } from "../src/store/store.ts";
import { runDoctor } from "../src/check/doctor.ts";
import { profileFromLock, type ProfileLock } from "../src/profile/define.ts";
import { readFileSync } from "node:fs";

const fixture = join(import.meta.dirname, "..", "examples", "mainframe-mini");
let stateDir: string;

before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "trestle-doctor-"));
  const overrides = { state: stateDir };
  await runCli(["profile", "build"], fixture, overrides);
  await runCli(["extract"], fixture, overrides);
  await runCli(["resolve"], fixture, overrides);
});
after(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function openStore(): Store {
  const lock = JSON.parse(readFileSync(join(fixture, "profile.lock.json"), "utf8")) as ProfileLock;
  const store = new Store(join(stateDir, "trestle.db"));
  store.activateProfile(profileFromLock(lock), lock.hash);
  return store;
}

const findingsById = (store: Store) => new Map(runDoctor(store).findings.map((f) => [f.id, f]));

test("healthy graph passes every check", () => {
  const store = openStore();
  try {
    const report = runDoctor(store);
    assert.equal(report.errors, 0, JSON.stringify(report.findings.filter((f) => f.count > 0)));
    assert.equal(report.warnings, 0);
    assert.ok(report.findings.length >= 9, "all checks reported, including passing ones");
  } finally {
    store.close();
  }
});

test("each pathology fires its check", () => {
  const store = openStore();
  const db = store.db;
  try {
    db.exec(`
      -- near-duplicate + identity hygiene: same Program name modulo case/whitespace
      INSERT INTO nodes (kind, identity, stable_id, props, provenance, owner, created_rev)
        VALUES ('Program', '{"name":" acct01"}', 'fake-dupe-1', '{}', 'declared', 'test', 1);
      -- vocabulary drift: kind not in the profile
      INSERT INTO nodes (kind, identity, stable_id, props, provenance, owner, created_rev)
        VALUES ('Ghost', '{"name":"boo"}', 'fake-ghost', '{}', 'declared', 'test', 1);
      -- orphan edge + edge without evidence: endpoints never existed
      INSERT INTO edges (kind, from_stable, to_stable, identity, stable_id, props, owner, created_rev)
        VALUES ('CALLS', 'no-such-node', 'also-missing', '{}', 'fake-orphan-edge', '{}', 'test', 1);
      -- stale evidence: cites a fact id that does not exist
      INSERT INTO evidence (entity_type, entity_stable, fact_id, resolver, created_rev)
        VALUES ('edge', 'fake-orphan-edge', 999999, 'test-resolver', 1);
      -- duplicate facts: identical rows from two cells
      INSERT INTO facts (kind, version, cell, source_path, locator, confidence, props, created_rev)
        VALUES ('call-observed', 1, 'cell-a', 'x.cbl', NULL, 1, '{"callee":"Z"}', 1),
               ('call-observed', 1, 'cell-b', 'x.cbl', NULL, 1, '{"callee":"Z"}', 1);
      -- duplicate evidence: same entity/fact/resolver/rule twice
      INSERT INTO evidence (entity_type, entity_stable, fact_id, resolver, rule, created_rev)
        SELECT 'node', 'fake-dupe-1', MIN(id), 'test-resolver', 'r', 1 FROM facts
        UNION ALL
        SELECT 'node', 'fake-dupe-1', MIN(id), 'test-resolver', 'r', 1 FROM facts;
      -- dangling alias: nodes that are not live
      INSERT INTO aliases (canonical_stable, alias_stable, resolver, created_rev)
        VALUES ('no-such-canonical', 'no-such-alias', 'test-resolver', 1);
    `);

    const byId = findingsById(store);
    assert.ok(byId.get("near-duplicate-identities")!.count >= 1, "near-duplicate");
    assert.ok(byId.get("identity-hygiene")!.count >= 1, "hygiene (leading space)");
    assert.ok(byId.get("vocabulary-drift")!.count >= 1, "drift (Ghost)");
    assert.ok(byId.get("orphan-edges")!.count >= 1, "orphan edge");
    assert.ok(byId.get("stale-evidence")!.count >= 1, "stale evidence");
    assert.ok(byId.get("duplicate-facts")!.count >= 1, "duplicate facts");
    assert.ok(byId.get("duplicate-evidence")!.count >= 1, "duplicate evidence");
    assert.ok(byId.get("dangling-aliases")!.count >= 1, "dangling alias");
    // declared node fake-dupe-1 has evidence rows above; Ghost does not:
    assert.ok(byId.get("declared-nodes-without-evidence")!.count >= 1, "declared w/o evidence");

    const report = runDoctor(store);
    assert.ok(report.errors >= 3);
  } finally {
    // Remove fabricated rows so this state dir stays reusable.
    db.exec(`
      DELETE FROM nodes WHERE owner = 'test';
      DELETE FROM edges WHERE owner = 'test';
      DELETE FROM evidence WHERE resolver = 'test-resolver';
      DELETE FROM facts WHERE cell IN ('cell-a', 'cell-b');
      DELETE FROM aliases WHERE resolver = 'test-resolver';
    `);
    store.close();
  }
});

test("alias-unified near-duplicates are not reported", () => {
  const store = openStore();
  const db = store.db;
  try {
    db.exec(`
      INSERT INTO nodes (kind, identity, stable_id, props, provenance, owner, created_rev)
        VALUES ('Program', '{"name":"ACCT01 "}', 'fake-dupe-2', '{}', 'declared', 'test', 1);
    `);
    const realAcct01 = (
      db
        .prepare(
          `SELECT stable_id FROM nodes WHERE kind = 'Program'
           AND json_extract(identity, '$.name') = 'ACCT01' AND retired_rev IS NULL`,
        )
        .get() as { stable_id: string }
    ).stable_id;
    let byId = findingsById(store);
    assert.ok(byId.get("near-duplicate-identities")!.count >= 1, "duplicate visible before alias");

    db.prepare(
      `INSERT INTO aliases (canonical_stable, alias_stable, resolver, created_rev) VALUES (?, 'fake-dupe-2', 'test-resolver', 1)`,
    ).run(realAcct01);
    byId = findingsById(store);
    assert.equal(byId.get("near-duplicate-identities")!.count, 0, "alias-unified pair suppressed");
  } finally {
    db.exec(`
      DELETE FROM nodes WHERE owner = 'test';
      DELETE FROM aliases WHERE resolver = 'test-resolver';
    `);
    store.close();
  }
});
