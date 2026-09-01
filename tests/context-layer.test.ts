/**
 * The context layer (skills + the committed graph-repo user surface) and
 * the incrementality fixes surfaced by the OFBiz dogfood run: fingerprint
 * seeds invalidate cells on code/profile change, and stale cells retire
 * their facts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store/store.ts";
import { buildLock, defineProfile } from "../src/profile/define.ts";
import { t } from "../src/profile/schema.ts";
import { pipeline } from "../src/extract/pipeline.ts";
import { runExtraction } from "../src/extract/run.ts";
import { resolver } from "../src/resolve/sdk.ts";
import { runResolvers } from "../src/resolve/run.ts";

const REPO = join(import.meta.dirname, "..");
const SKILLS_DIR = join(REPO, ".agents", "skills");

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

test("the graph repo ships its user surface committed at the root", () => {
  // The repo IS the application: no init, no scaffold, no install of
  // trestle itself. These files must exist in every clone.
  for (const f of ["trestle.config.ts", "profile.ts", "extract/pipeline.ts", "resolvers/inventory.ts", "AGENTS.md"]) {
    assert.ok(existsSync(join(REPO, f)), `missing user-surface file ${f}`);
  }
  const configText = readFileSync(join(REPO, "trestle.config.ts"), "utf8");
  assert.match(configText, /corpusRoots: \["corpora"\]/);
  assert.match(configText, /visualization:/);
  // Node package self-reference: user files import "trestle" from source.
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
  assert.equal(pkg.name, "trestle");
  assert.equal(pkg.exports["."], "./src/index.ts");
  // Environment bootstrap: executable, inits submodules, installs at root.
  const setup = join(REPO, ".agents", "setup");
  assert.ok(existsSync(setup), "missing .agents/setup");
  assert.ok(statSync(setup).mode & 0o100, ".agents/setup not executable");
  const setupText = readFileSync(setup, "utf8");
  assert.match(setupText, /git submodule update --init --depth 1/);
  assert.match(setupText, /^npm install$/m);
  // Graph endpoint declared as a supervised orb service.
  assert.match(readFileSync(join(REPO, ".amp", "services.yaml"), "utf8"), /trestle\.js serve --host 0\.0\.0\.0 --port "\$PORT"/);
  assert.ok(existsSync(join(REPO, ".amp", "plugins", "trestle.ts")), "missing .amp/plugins/trestle.ts");
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

test("declared nodes retire when their facts disappear", async () => {
  const { dir, corpus, store } = makeEnv();
  try {
    const opts = { corpusRoots: [corpus], stateDir: join(dir, ".state"), fingerprintSeed: "s" };
    const fileNodes = resolver({
      name: "file-nodes",
      phase: 10,
      consumes: { facts: ["file-seen"] },
      run(slice, emit) {
        for (const fact of slice.facts("file-seen")) {
          emit.node("File", { path: fact.props.path as string }, {}, { evidence: [fact] });
        }
      },
    });
    await runExtraction(store, perFilePipeline("cell"), opts);
    await runResolvers(store, [fileNodes]);
    assert.equal(store.liveNodes().length, 2);

    // The file vanishes: its cell is never invoked again, its fact retires,
    // and on re-resolve the declared node must retire with it.
    rmSync(join(corpus, "b.txt"));
    await runExtraction(store, perFilePipeline("cell"), opts);
    await runResolvers(store, [fileNodes]);
    const live = store.liveNodes();
    assert.equal(live.length, 1, "node without live evidence retired");
    assert.equal((live[0]!.identity as { path: string }).path, "a.txt");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
