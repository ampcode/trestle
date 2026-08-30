/**
 * Regression: memo cells that invoke run() must still skip on unchanged
 * inputs. The committed fingerprint once included run() invocation records
 * that the probe could not reconstruct without executing the cell, so every
 * tool-backed cell missed its memo forever (found dogfooding scip-java/javac
 * extraction over OFBiz).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineProfile, buildLock } from "../src/profile/define.ts";
import { t } from "../src/profile/schema.ts";
import { pipeline } from "../src/extract/pipeline.ts";
import { runExtraction } from "../src/extract/run.ts";
import { Store } from "../src/store/store.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "trestle-memo-"));
  mkdirSync(join(dir, "corpus"));
  writeFileSync(join(dir, "corpus", "a.txt"), "alpha\n");
  writeFileSync(join(dir, "corpus", "b.txt"), "beta\n");
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const profile = defineProfile({
  nodes: { Thing: { identity: ["name"], props: { name: t.string() } } },
  edges: {},
  facts: { "line-observed": { version: 1, props: { text: t.string() } } },
});

function toolBackedPipeline() {
  return pipeline(async ({ corpus, memo, emit, run }) => {
    for (const path of corpus.list(".txt")) {
      await memo(`cat:${path}`, [path], () => {
        // External tool output feeds the fact; nothing about this
        // invocation may leak into the committed fingerprint.
        const out = run("cat", [join(dir, "corpus", path)]);
        emit({
          kind: "line-observed",
          sourcePath: path,
          locator: { type: "lines", startLine: 1 },
          props: { text: out.stdout.trim() },
        });
      });
    }
  });
}

test("tool-backed memo cells skip when inputs are unchanged", async () => {
  const store = new Store(join(dir, "trestle.db"));
  store.activateProfile(profile, buildLock(profile).hash);
  const opts = { corpusRoots: [join(dir, "corpus")], stateDir: join(dir, ".state"), fingerprintSeed: "seed1" };

  const first = await runExtraction(store, toolBackedPipeline(), opts);
  assert.equal(first.cells.computed, 2);
  assert.equal(first.cells.failed, 0);
  assert.equal(first.facts.emitted, 2);

  const second = await runExtraction(store, toolBackedPipeline(), opts);
  assert.equal(second.cells.computed, 0, "unchanged tool-backed cells must skip");
  assert.equal(second.cells.skipped, 2);
  assert.equal(second.facts.emitted, 0);

  // Changing one input recomputes exactly that cell.
  writeFileSync(join(dir, "corpus", "a.txt"), "alpha-changed\n");
  const third = await runExtraction(store, toolBackedPipeline(), opts);
  assert.equal(third.cells.computed, 1);
  assert.equal(third.cells.skipped, 1);

  // Changing the seed (pipeline code / profile hash) recomputes everything.
  const fourth = await runExtraction(store, toolBackedPipeline(), { ...opts, fingerprintSeed: "seed2" });
  assert.equal(fourth.cells.computed, 2);

  store.close();
});
