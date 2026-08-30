/**
 * The context layer (packaged skills + init stubs) and the incrementality
 * fixes surfaced by the OFBiz dogfood run: fingerprint seeds invalidate
 * cells on code/profile change, and stale cells retire their facts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/main.ts";
import { Store } from "../src/store/store.ts";
import { buildLock, defineProfile } from "../src/profile/define.ts";
import { t } from "../src/profile/schema.ts";
import { pipeline } from "../src/extract/pipeline.ts";
import { runExtraction } from "../src/extract/run.ts";

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");

test("packaged skills are well-formed", () => {
  const dirs = readdirSync(SKILLS_DIR);
  assert.ok(dirs.length >= 4, `expected >= 4 skills, found ${dirs.length}`);
  for (const dir of dirs) {
    const content = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
    const name = /^name:\s*(.+)$/m.exec(content)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim();
    assert.equal(name, dir, `frontmatter name must match directory: ${dir}`);
    assert.ok(description && description.length > 20, `${dir}: description required`);
    assert.match(content, /^---\n/, `${dir}: must start with frontmatter`);
    assert.ok(content.split("\n").length < 500, `${dir}: keep SKILL.md under 500 lines`);
  }
});

test("init scaffolds host-level skill stubs", async () => {
  const host = mkdtempSync(join(tmpdir(), "trestle-init-"));
  try {
    await runCli(["init"], host);
    for (const dir of readdirSync(SKILLS_DIR)) {
      const stub = join(host, ".agents", "skills", dir, "SKILL.md");
      assert.ok(existsSync(stub), `missing stub ${dir}`);
      const content = readFileSync(stub, "utf8");
      assert.match(content, new RegExp(`name: ${dir}`));
      assert.match(content, /Project addenda/);
      assert.match(content, new RegExp(`node_modules/trestle/skills/${dir}/SKILL.md`));
    }
    // Amp plugin is scaffolded verbatim from the packaged copy.
    const plugin = join(host, ".amp", "plugins", "trestle.ts");
    assert.ok(existsSync(plugin), "missing .amp/plugins/trestle.ts");
    const packaged = readFileSync(join(import.meta.dirname, "..", ".amp", "plugins", "trestle.ts"), "utf8");
    assert.equal(readFileSync(plugin, "utf8"), packaged);
    // Re-init never overwrites: mark a stub and the plugin, re-run, markers survive.
    const marker = join(host, ".agents", "skills", readdirSync(SKILLS_DIR)[0]!, "SKILL.md");
    writeFileSync(marker, "EDITED\n");
    writeFileSync(plugin, "EDITED\n");
    await runCli(["init"], host);
    assert.equal(readFileSync(marker, "utf8"), "EDITED\n");
    assert.equal(readFileSync(plugin, "utf8"), "EDITED\n");
  } finally {
    rmSync(host, { recursive: true, force: true });
  }
});

/** ---------- incrementality fixes ---------- */

const profile = defineProfile({
  nodes: { File: { identity: ["path"] } },
  edges: {},
  facts: { "file-seen": { version: 1, props: { path: t.string() } } },
});

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "trestle-incr-"));
  const corpus = join(dir, "corpus");
  mkdirSync(corpus, { recursive: true });
  writeFileSync(join(corpus, "a.txt"), "alpha\n");
  writeFileSync(join(corpus, "b.txt"), "beta\n");
  const store = new Store(join(dir, "trestle.db"));
  store.activateProfile(profile, buildLock(profile).hash);
  return { dir, corpus, store };
}

const perFilePipeline = (cellPrefix: string) =>
  pipeline(async ({ corpus, memo, emit }) => {
    for (const path of corpus.list(".txt")) {
      await memo(`${cellPrefix}:${path}`, [path], () => {
        emit({ kind: "file-seen", sourcePath: path, props: { path } });
      });
    }
  });

test("fingerprintSeed change recomputes all cells", async () => {
  const { dir, corpus, store } = makeEnv();
  try {
    const opts = { corpusRoots: [corpus], stateDir: join(dir, ".state") };
    const r1 = await runExtraction(store, perFilePipeline("cell"), { ...opts, fingerprintSeed: "code-v1" });
    assert.equal(r1.cells.computed, 2);
    const r2 = await runExtraction(store, perFilePipeline("cell"), { ...opts, fingerprintSeed: "code-v1" });
    assert.equal(r2.cells.skipped, 2, "same seed: all cells skip");
    const r3 = await runExtraction(store, perFilePipeline("cell"), { ...opts, fingerprintSeed: "code-v2" });
    assert.equal(r3.cells.computed, 2, "new seed: all cells recompute");
    assert.equal(r3.facts.retired, 2, "recomputed cells retire prior facts");
    assert.equal(store.factCounts().find((c) => c.kind === "file-seen")?.count, 2, "no duplicates");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale cells (renamed keys) retire their facts", async () => {
  const { dir, corpus, store } = makeEnv();
  try {
    const opts = { corpusRoots: [corpus], stateDir: join(dir, ".state"), fingerprintSeed: "s" };
    await runExtraction(store, perFilePipeline("old"), opts);
    assert.equal(store.factCounts().find((c) => c.kind === "file-seen")?.count, 2);
    // Rename every memo key: old cells are never invoked again.
    const r2 = await runExtraction(store, perFilePipeline("new"), opts);
    assert.equal(r2.cells.computed, 2);
    assert.equal(r2.cells.stale, 2, "uninvoked cells detected as stale");
    assert.equal(
      store.factCounts().find((c) => c.kind === "file-seen")?.count,
      2,
      "stale facts retired: no duplicates after key rename",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale sweep is skipped when a cell fails", async () => {
  const { dir, corpus, store } = makeEnv();
  try {
    const opts = { corpusRoots: [corpus], stateDir: join(dir, ".state"), fingerprintSeed: "s" };
    await runExtraction(store, perFilePipeline("cell"), opts);
    const crashing = pipeline(async ({ memo }) => {
      await memo("boom", [], () => {
        throw new Error("crash");
      });
    });
    const r = await runExtraction(store, crashing, opts);
    assert.equal(r.cells.failed, 1);
    assert.equal(r.cells.stale, 0, "no stale sweep on a failed run");
    assert.equal(store.factCounts().find((c) => c.kind === "file-seen")?.count, 2, "facts preserved");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
