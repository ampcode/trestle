/**
 * The context layer (packaged skills + init stubs) and the incrementality
 * fixes surfaced by the OFBiz dogfood run: fingerprint seeds invalidate
 * cells on code/profile change, and stale cells retire their facts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
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

test("init copies full packaged skills to the host", async () => {
  const host = mkdtempSync(join(tmpdir(), "trestle-init-"));
  try {
    await runCli(["init"], host);
    const services = join(host, ".amp", "services.yaml");
    assert.ok(existsSync(services), "missing Amp service declaration");
    assert.match(readFileSync(services, "utf8"), /cwd: trestle/);
    assert.match(readFileSync(services, "utf8"), /npx --no-install trestle serve --host 0\.0\.0\.0 --port "\$PORT"/);
    assert.equal(readFileSync(join(host, ".amp", ".gitignore"), "utf8"), "portals/\n");
    assert.match(readFileSync(join(host, "trestle", "trestle.config.ts"), "utf8"), /visualization:/);
    for (const dir of readdirSync(SKILLS_DIR)) {
      const installed = join(host, ".agents", "skills", dir, "SKILL.md");
      assert.ok(existsSync(installed), `missing skill ${dir}`);
      const content = readFileSync(installed, "utf8");
      const packagedSkill = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
      assert.ok(content.startsWith(packagedSkill.trimEnd()), `${dir}: not the full packaged content`);
      assert.match(content, /Project addenda/);
    }
    // Harness manifest pins the installed engine version; tsconfig ships too.
    const manifest = JSON.parse(readFileSync(join(host, "trestle", "package.json"), "utf8"));
    const ownVersion = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version;
    assert.equal(manifest.dependencies.trestle, `git+https://ampcode.com/@jesse/trestle#semver:^${ownVersion}`);
    assert.ok(existsSync(join(host, "trestle", "tsconfig.json")), "missing tsconfig.json");
    // Environment bootstrap: executable, targets the harness dir.
    const setup = join(host, ".agents", "setup");
    assert.ok(existsSync(setup), "missing .agents/setup");
    assert.ok(statSync(setup).mode & 0o100, ".agents/setup not executable");
    assert.match(readFileSync(setup, "utf8"), /cd trestle && npm install/);
    // Amp plugin is scaffolded verbatim from the packaged copy.
    const plugin = join(host, ".amp", "plugins", "trestle.ts");
    assert.ok(existsSync(plugin), "missing .amp/plugins/trestle.ts");
    const packaged = readFileSync(join(import.meta.dirname, "..", ".amp", "plugins", "trestle.ts"), "utf8");
    assert.equal(readFileSync(plugin, "utf8"), packaged);
    // Re-init never overwrites: mark a stub and the plugin, re-run, markers survive.
    const marker = join(host, ".agents", "skills", readdirSync(SKILLS_DIR)[0]!, "SKILL.md");
    writeFileSync(marker, "EDITED\n");
    writeFileSync(plugin, "EDITED\n");
    writeFileSync(services, "services:\n  app:\n    command: npm start\n");
    await runCli(["init"], host);
    assert.equal(readFileSync(marker, "utf8"), "EDITED\n");
    assert.equal(readFileSync(plugin, "utf8"), "EDITED\n");
    assert.equal(readFileSync(services, "utf8"), "services:\n  app:\n    command: npm start\n");
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
