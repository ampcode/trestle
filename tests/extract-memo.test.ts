/**
 * Regression: memo cells that invoke run() must still skip on unchanged
 * inputs. The committed fingerprint once included run() invocation records
 * that the probe could not reconstruct without executing the cell, so every
 * tool-backed cell missed its memo forever (seen with scip-java/javac
 * extraction over a large Java corpus).
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

test("run captures stdout, stderr, and status from a nonzero process exit", async () => {
  const store = new Store(":memory:");
  store.activateProfile(profile, buildLock(profile).hash);
  try {
    await runExtraction(store, pipeline(({ run }) => {
      const result = run(process.execPath, [
        "-e",
        "process.stdout.write('partial output'); process.stderr.write('tool failure'); process.exitCode = 7;",
      ]);
      assert.deepEqual(result, { stdout: "partial output", stderr: "tool failure", status: 7 });
    }), { corpusRoots: [], stateDir: dir });
  } finally {
    store.close();
  }
});

test("run identifies a missing executable instead of returning a process result", async () => {
  const store = new Store(":memory:");
  store.activateProfile(profile, buildLock(profile).hash);
  const missingTool = join(dir, "nonexistent-executable");
  try {
    await runExtraction(store, pipeline(({ run }) => {
      assert.throws(() => run(missingTool, []), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.startsWith(`run(${missingTool}): `));
        assert.match(error.message, /ENOENT/);
        return true;
      });
    }), { corpusRoots: [], stateDir: dir });
  } finally {
    store.close();
  }
});

for (const failure of ["invalid fact", "memo write"] as const) {
  test(`cell replacement rolls back on ${failure} and can retry`, async () => {
    const store = new Store(":memory:");
    store.activateProfile(profile, buildLock(profile).hash);
    const opts = { corpusRoots: [], stateDir: dir, fingerprintSeed: "old" };
    let invalid = false;
    const makePipeline = (text: string) => pipeline(async ({ memo, emit }) => {
      await memo("cell", [], () => {
        emit({ kind: "line-observed", sourcePath: "a.txt", props: { text } });
        if (invalid) emit({ kind: "line-observed", sourcePath: "a.txt", props: { text: 42 } });
      });
    });
    try {
      await runExtraction(store, makePipeline("old"), opts);
      const oldFacts = store.factsByKind("line-observed");
      const oldMemo = store.getMemoCell("cell");
      if (failure === "invalid fact") invalid = true;
      else store.db.exec(`
        CREATE TRIGGER fail_memo BEFORE UPDATE ON memo_cells
        BEGIN SELECT RAISE(ABORT, 'memo write failed'); END;
      `);

      const nextOpts = { ...opts, fingerprintSeed: "new" };
      const failed = await runExtraction(store, makePipeline("new"), nextOpts);
      assert.equal(failed.cells.failed, 1);
      assert.equal(failed.cells.computed, 0);
      assert.deepEqual(failed.facts, { emitted: 0, retired: 0 });
      assert.match(failed.errors[0]!.error, failure === "invalid fact" ? /emit rejected/ : /memo write failed/);
      assert.deepEqual(store.factsByKind("line-observed"), oldFacts);
      assert.deepEqual(store.getMemoCell("cell"), oldMemo);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM facts").get()?.c, 1);

      invalid = false;
      if (failure === "memo write") store.db.exec("DROP TRIGGER fail_memo");
      const retried = await runExtraction(store, makePipeline("new"), nextOpts);
      assert.equal(retried.cells.computed, 1);
      assert.deepEqual(retried.facts, { emitted: 1, retired: 1 });
      assert.deepEqual(store.factsByKind("line-observed").map(f => f.props), [{ text: "new" }]);
      assert.notDeepEqual(store.getMemoCell("cell"), oldMemo);
      const unchanged = await runExtraction(store, makePipeline("new"), nextOpts);
      assert.equal(unchanged.cells.skipped, 1);
    } finally {
      store.close();
    }
  });
}

test("root fact replacement is atomic", async () => {
  const store = new Store(":memory:");
  store.activateProfile(profile, buildLock(profile).hash);
  const opts = { corpusRoots: [], stateDir: dir };
  const rootPipeline = (texts: (string | number)[]) => pipeline(({ emit }) => {
    for (const text of texts) emit({ kind: "line-observed", sourcePath: "root.txt", props: { text } });
  });
  try {
    await runExtraction(store, rootPipeline(["old"]), opts);
    const oldFacts = store.factsByKind("line-observed");
    await assert.rejects(runExtraction(store, rootPipeline(["new", 42]), opts), /emit rejected/);
    assert.deepEqual(store.factsByKind("line-observed"), oldFacts);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM facts").get()?.c, 1);
    const retried = await runExtraction(store, rootPipeline(["new"]), opts);
    assert.deepEqual(retried.facts, { emitted: 1, retired: 1 });
    assert.deepEqual(store.factsByKind("line-observed").map(f => f.props), [{ text: "new" }]);
  } finally {
    store.close();
  }
});

test("a missing declared input fails only its cell and preserves its prior facts", async () => {
  const store = new Store(":memory:");
  store.activateProfile(profile, buildLock(profile).hash);
  const opts = { corpusRoots: [], stateDir: dir };
  const makePipeline = (inputs: string[]) => pipeline(async ({ memo, emit }) => {
    await memo("missing", inputs, () => {
      emit({ kind: "line-observed", sourcePath: "missing.txt", props: { text: "old" } });
    });
    await memo("healthy", [], () => {
      emit({ kind: "line-observed", sourcePath: "healthy.txt", props: { text: "healthy" } });
    });
  });
  try {
    await runExtraction(store, makePipeline([]), opts);
    const oldFacts = store.factsByKind("line-observed").filter(f => f.cell === "missing");
    const oldMemo = store.getMemoCell("missing");
    const result = await runExtraction(store, makePipeline(["missing.txt"]), { ...opts, fingerprintSeed: "new" });
    assert.equal(result.cells.failed, 1);
    assert.equal(result.cells.computed, 1);
    assert.deepEqual(result.facts, { emitted: 1, retired: 1 });
    assert.deepEqual(store.factsByKind("line-observed").filter(f => f.cell === "missing"), oldFacts);
    assert.deepEqual(store.getMemoCell("missing"), oldMemo);
  } finally {
    store.close();
  }
});
