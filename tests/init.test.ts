import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initProject } from "../src/cli/init.ts";
import { findConfig, loadConfig } from "../src/cli/config.ts";
import { packageManager } from "../src/cli/package.ts";
import { Store } from "../src/store/store.ts";
import { defineProfile, buildLock } from "../src/profile/define.ts";
import { pipeline } from "../src/extract/pipeline.ts";
import { runExtraction } from "../src/extract/run.ts";

test("init preserves application module type, dependencies and edited graph files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-init-"));
  try {
    const application = JSON.stringify({ type: "commonjs", scripts: { test: "existing" }, devDependencies: { typescript: "5.7.3" }, packageManager: "pnpm@10.0.0" });
    writeFileSync(join(dir, "package.json"), application);
    writeFileSync(join(dir, "pnpm-lock.yaml"), "existing lockfile\n");
    initProject(dir, ["--no-install"]);
    assert.equal(readFileSync(join(dir, "package.json"), "utf8"), application);
    assert.equal(readFileSync(join(dir, "pnpm-lock.yaml"), "utf8"), "existing lockfile\n");
    const pkg = JSON.parse(readFileSync(join(dir, "trestle/package.json"), "utf8"));
    assert.equal(pkg.type, "module");
    assert.equal(pkg.devDependencies.typescript, "^5.8.0");
    assert.ok(pkg.devDependencies.trestle);
    const cfg = await loadConfig(join(dir, "trestle"));
    assert.deepEqual(cfg.corpusRoots, [dir]);
    assert.equal(cfg.stateDir, join(dir, "trestle/.state"));
    writeFileSync(cfg.profilePath, "// user-authored profile\n");
    const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
    initProject(dir, ["--no-install"]);
    assert.equal(readFileSync(cfg.profilePath, "utf8"), "// user-authored profile\n");
    assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), ignore);
    mkdirSync(join(dir, "child/.git"), { recursive: true });
    assert.equal(findConfig(join(dir, "child")), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init refuses collisions and nested initialization before writing", () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-init-conflict-"));
  try {
    mkdirSync(join(dir, "trestle"));
    writeFileSync(join(dir, "trestle/profile.ts"), "keep");
    assert.throws(() => initProject(dir, ["--no-install"]), /refusing to overwrite/);
    assert.equal(existsSync(join(dir, "trestle.config.mts")), false);
    writeFileSync(join(dir, "trestle.config.ts"), "export default {};");
    assert.throws(() => initProject(dir, ["child", "--no-install"]), /already inside/);
    assert.equal(existsSync(join(dir, "child")), false);
    assert.throws(() => initProject(dir, ["--typo"]), /usage/);
    writeFileSync(join(dir, "package.json"), '{"packageManager":"pnpm@10.0.0"}');
    assert.equal(packageManager(dir), "pnpm");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("init bootstraps non-Node repositories and preserves legacy configured paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-init-empty-"));
  try {
    initProject(dir, ["application", "--no-install"]);
    assert.equal(existsSync(join(dir, "application/package.json")), false);
    const pkg = JSON.parse(readFileSync(join(dir, "application/trestle/package.json"), "utf8"));
    assert.equal(pkg.private, true);
    assert.ok(pkg.devDependencies.trestle);
    writeFileSync(join(dir, "trestle.config.ts"), 'export default { state: "history", corpusRoots: ["estates"] };');
    assert.throws(() => initProject(dir, ["--no-install"]), /does not automatically migrate/);
    const config = await loadConfig(dir);
    assert.equal(config.stateDir, join(dir, "history"));
    assert.equal(config.profilePath, join(dir, "profile.ts"));
    assert.deepEqual(config.corpusRoots, [join(dir, "estates")]);
    assert.equal(existsSync(join(dir, "trestle.config.mts")), false);
    assert.equal(existsSync(join(dir, "trestle")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("in-repo extraction respects gitignore, explicit exclusions, state and symlinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trestle-corpus-"));
  const state = join(dir, "custom-state");
  execFileSync("git", ["init", "--quiet", dir]);
  writeFileSync(join(dir, ".gitignore"), "ignored/\n*.secret\n");
  mkdirSync(join(dir, "ignored"));
  mkdirSync(join(dir, "trestle"));
  writeFileSync(join(dir, "ignored/file"), "ignored");
  writeFileSync(join(dir, "password.secret"), "not a real secret");
  writeFileSync(join(dir, "trestle/profile.ts"), "excluded");
  writeFileSync(join(dir, "source.ts"), "source");
  mkdirSync(join(dir, "replaced"));
  writeFileSync(join(dir, "replaced/source.ts"), "formerly tracked");
  execFileSync("git", ["add", "source.ts", "replaced/source.ts"], { cwd: dir });
  rmSync(join(dir, "replaced"), { recursive: true });
  symlinkSync(dir, join(dir, "replaced"));
  symlinkSync(dir, join(dir, "cycle"));
  const store = new Store(join(state, "trestle.db"));
  try {
    const profile = defineProfile({ nodes: {}, edges: {}, facts: {} });
    store.activateProfile(profile, buildLock(profile).hash);
    let paths: string[] = [];
    const def = pipeline(({ corpus }) => { paths = corpus.list(); });
    await runExtraction(store, def, { corpusRoots: [dir], stateDir: state, corpusExclude: [join(dir, "trestle")], respectGitignore: true });
    assert.deepEqual(paths, [".gitignore", "source.ts"]);
    rmSync(join(dir, ".git"), { recursive: true });
    await runExtraction(store, def, { corpusRoots: [dir], stateDir: state, corpusExclude: [join(dir, "trestle"), join(dir, "ignored")] });
    assert.deepEqual(paths, [".gitignore", "password.secret", "source.ts"]);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
