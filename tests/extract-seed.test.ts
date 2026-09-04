/**
 * Regression: the extraction fingerprint seed must not move because a
 * pipeline's own helper tooling wrote build output beside its sources.
 *
 * A pipeline that shells out to Python leaves `__pycache__` under `extract/`
 * the first time it runs. If the seed hashes it, the *next* run hashes a
 * directory that did not exist during the previous one, the seed changes, and
 * every memo cell misses — a pipeline that re-reads the whole estate on every
 * invocation, with nothing in the output to say why.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashDirSources } from "../src/extract/seed.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "trestle-seed-"));
  writeFileSync(join(dir, "pipeline.ts"), "export default 1;\n");
  mkdirSync(join(dir, "parsers"));
  writeFileSync(join(dir, "parsers", "reader.py"), "x = 1\n");
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("bytecode written beside a helper does not move the seed", () => {
  const before = hashDirSources(dir);
  mkdirSync(join(dir, "parsers", "__pycache__"));
  writeFileSync(join(dir, "parsers", "__pycache__", "reader.cpython-312.pyc"), "\x00compiled");
  assert.equal(hashDirSources(dir), before, "__pycache__ must be excluded from the seed");
});

test("a virtualenv beside the pipeline does not move the seed", () => {
  const before = hashDirSources(dir);
  mkdirSync(join(dir, ".venv", "lib"), { recursive: true });
  writeFileSync(join(dir, ".venv", "lib", "anything.py"), "y = 2\n");
  assert.equal(hashDirSources(dir), before, ".venv must be excluded from the seed");
});

test("a stray compiled artifact does not move the seed", () => {
  const before = hashDirSources(dir);
  writeFileSync(join(dir, "parsers", "reader.pyc"), "\x00compiled");
  assert.equal(hashDirSources(dir), before, "compiled files must be excluded from the seed");
});

test("editing a helper source does move the seed", () => {
  // The exclusions must not be so broad that real tool edits stop
  // invalidating cells — that is the whole point of hashing non-.ts files.
  const before = hashDirSources(dir);
  writeFileSync(join(dir, "parsers", "reader.py"), "x = 2\n");
  assert.notEqual(hashDirSources(dir), before);
});

test("adding a helper source does move the seed", () => {
  const before = hashDirSources(dir);
  writeFileSync(join(dir, "parsers", "grammar.txt"), "rule\n");
  assert.notEqual(hashDirSources(dir), before);
});

test("editing pipeline code does move the seed", () => {
  const before = hashDirSources(dir);
  writeFileSync(join(dir, "pipeline.ts"), "export default 2;\n");
  assert.notEqual(hashDirSources(dir), before);
});
