import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installAmp, uninstallAmp } from "../src/cli/amp.ts";
import { parse } from "yaml";

const fixture = (): string => mkdtempSync(join(tmpdir(), "trestle-amp-install-"));

test("Amp install refreshes idempotently and uninstall is scoped", () => {
  const root = fixture();
  try {
    mkdirSync(join(root, ".agents"), { recursive: true });
    mkdirSync(join(root, ".amp"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Existing guidance\n");
    writeFileSync(join(root, ".agents/setup"), "#!/bin/sh\necho existing\n");
    writeFileSync(join(root, ".amp/services.yaml"), "services:\n  app:\n    command: npm start\n");
    mkdirSync(join(root, "trestle"));
    writeFileSync(join(root, "trestle/profile.ts"), "graph code");
    installAmp(root);
    const first = readFileSync(join(root, "AGENTS.md"), "utf8");
    installAmp(root);
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), first);
    assert.match(readFileSync(join(root, ".amp/services.yaml"), "utf8"), /app:[\s\S]*trestle:/);
    assert.match(readFileSync(join(root, ".agents/setup"), "utf8"), /TRESTLE_SETUP_ROOT=[\s\S]*echo existing[\s\S]*corpus restore/);
    assert.doesNotMatch(readFileSync(join(root, ".amp/plugins/trestle/index.js"), "utf8"), /src\/coordination/);
    uninstallAmp(root);
    assert.equal(readFileSync(join(root, "trestle/profile.ts"), "utf8"), "graph code");
    assert.equal(readFileSync(join(root, "AGENTS.md"), "utf8"), "# Existing guidance\n");
    assert.equal(readFileSync(join(root, ".agents/setup"), "utf8"), "#!/bin/sh\necho existing\n");
    assert.match(readFileSync(join(root, ".amp/services.yaml"), "utf8"), /app:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Amp service merging handles fresh, inline and indented YAML without touching other keys", () => {
  for (const input of ["", "services: {}\n", "services:\n    app:\n        command: npm start\nother: keep\n"]) {
    const root = fixture();
    try {
      mkdirSync(join(root, ".amp"));
      if (input) writeFileSync(join(root, ".amp/services.yaml"), input);
      installAmp(root);
      const doc = parse(readFileSync(join(root, ".amp/services.yaml"), "utf8"));
      assert.equal(doc.services.trestle.health, "/health");
      installAmp(root);
      uninstallAmp(root);
      const after = parse(readFileSync(join(root, ".amp/services.yaml"), "utf8"));
      assert.equal(after.services.trestle, undefined);
      if (input.includes("other")) { assert.equal(after.other, "keep"); assert.equal(after.services.app.command, "npm start"); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Amp refresh updates owned sections across package versions and refuses service edits", () => {
  const root = fixture();
  try {
    installAmp(root);
    const manifestPath = join(root, ".amp/trestle-install.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const previous = manifest.sections["AGENTS.md"];
    manifest.sections["AGENTS.md"] = previous.replace("Trestle graph code", "Old graph code");
    writeFileSync(join(root, "AGENTS.md"), readFileSync(join(root, "AGENTS.md"), "utf8").replace(previous, manifest.sections["AGENTS.md"]));
    writeFileSync(manifestPath, JSON.stringify(manifest));
    installAmp(root);
    assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /Trestle graph code/);
    const servicePath = join(root, ".amp/services.yaml");
    writeFileSync(servicePath, readFileSync(servicePath, "utf8").replace("/health", "/changed"));
    assert.throws(() => installAmp(root), /service conflicts or was modified/);
    assert.throws(() => uninstallAmp(root), /service conflicts or was modified/);
    assert.ok(existsSync(join(root, ".amp/plugins/trestle/index.js")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Amp installer refuses symlink targets before writing anything", () => {
  const root = fixture();
  const outside = fixture();
  try {
    symlinkSync(outside, join(root, ".amp"));
    assert.throws(() => installAmp(root), /symlink/);
    assert.equal(existsSync(join(root, "AGENTS.md")), false);
    assert.equal(existsSync(join(outside, "trestle-install.json")), false);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("Amp install and uninstall refuse conflicts and modifications", () => {
  const conflict = fixture();
  const modified = fixture();
  try {
    mkdirSync(join(conflict, ".amp/plugins"), { recursive: true });
    writeFileSync(join(conflict, ".amp/plugins/trestle.ts"), "unrelated");
    assert.throws(() => installAmp(conflict), /conflicting unmanaged/);
    assert.equal(readFileSync(join(conflict, ".amp/plugins/trestle.ts"), "utf8"), "unrelated");

    installAmp(modified);
    writeFileSync(join(modified, ".amp/plugins/trestle/index.js"), "changed");
    assert.throws(() => uninstallAmp(modified), /modified file/);
    assert.equal(readFileSync(join(modified, ".amp/plugins/trestle/index.js"), "utf8"), "changed");
  } finally {
    rmSync(conflict, { recursive: true, force: true });
    rmSync(modified, { recursive: true, force: true });
  }
});
