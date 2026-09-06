import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.ts";
import { buildLock } from "../src/profile/define.ts";
import { runExtraction } from "../src/extract/run.ts";
import { runResolvers } from "../src/resolve/run.ts";
import { runDoctor } from "../src/check/doctor.ts";
import profile from "../tools/self-analysis/profile.ts";
import pipeline from "../tools/self-analysis/extract/pipeline.ts";
import resolver from "../tools/self-analysis/resolvers/audit.ts";

test("self-analysis finds clones and unused candidates without losing generic methods or dynamic imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-self-analysis-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(join(dir, "tsconfig.json"), '{"compilerOptions":{"module":"nodenext","target":"es2022"}}');
  writeFileSync(join(dir, "src/audit-fixture.ts"), `
export function original(value: number) {
  const result = value + 1; if (result > 10) { return result * 2; } return result - 3 + value * 2;
}
export function duplicate(value: number) {
  /* trivia does not change the body */
  const result=value+1; if(result>10){return result*2;} return result-3+value*2;
}
export function renamed(input: number) {
  const output = input + 1; if (output > 10) { return output * 2; } return output - 3 + input * 2;
}
export function dynamic() { return 10; }
function unused() { return false; }
export class Box<T> { read(value: T): T { return value; } }
`);
  writeFileSync(join(dir, "src/audit-consumer.ts"), `
import { original, duplicate, renamed, Box } from './audit-fixture.ts';
original(1); original(2); duplicate(1); renamed(2);
new Box<number>().read(1);
const { dynamic } = await import('./audit-fixture.ts'); dynamic();
`);
  const store = new Store(join(dir, ".state/trestle.db"));
  try {
    store.activateProfile(profile, buildLock(profile).hash);
    const opts = { corpusRoots: [dir], stateDir: join(dir, ".state") };
    const extracted = await runExtraction(store, pipeline, opts);
    assert.equal(extracted.cells.failed, 0, JSON.stringify(extracted.errors));
    await runResolvers(store, [resolver]);
    assert.equal(store.liveNodes("Function").length, 6);
    assert.equal(store.liveEdges("SAME_BODY").length, 1);
    assert.equal(store.liveEdges("SIMILAR_BODY").length, 2);
    const claims = store.db.prepare("SELECT detail FROM claims WHERE retired_rev IS NULL").all();
    assert.equal(claims.length, 1);
    assert.match(String(claims[0].detail), /::unused:/);
    const clone = store.liveEdges("SAME_BODY")[0];
    const proof = store.graphEvidence("edge", clone.stableId);
    assert.equal(proof.evidence.length, 2);
    assert.ok(proof.evidence.every(ev => ev.sourcePath === "src/audit-fixture.ts" && ev.fact?.authority?.tool === "typescript"));
    const health = runDoctor(store);
    assert.equal(health.errors + health.warnings, 0, JSON.stringify(health.findings));
    const repeated = await runExtraction(store, pipeline, opts);
    assert.equal(repeated.cells.computed, 0);
    assert.equal(repeated.cells.skipped, 1);
    const before = store.liveEdges().map(edge => edge.stableId);
    await runResolvers(store, [resolver]);
    assert.deepEqual(store.liveEdges().map(edge => edge.stableId), before);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
