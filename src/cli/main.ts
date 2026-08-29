import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLock, profileFromLock, type Profile, type ProfileLock } from "../profile/define.ts";
import { sha256 } from "../profile/canonical.ts";
import { Store } from "../store/store.ts";
import { isPipelineModule } from "../extract/pipeline.ts";
import { runExtraction } from "../extract/run.ts";
import { loadResolvers, runResolvers } from "../resolve/run.ts";
import { computeSurvey, renderSurvey } from "../survey/survey.ts";
import { loadConfig, type TrestleConfig } from "./config.ts";
import { TEMPLATES } from "./templates.ts";

const USAGE = `trestle <command>

  init                 scaffold a trestle/ project directory (never overwrites)
  profile build        compile profile.ts -> profile.lock.json
  profile check        verify profile.lock.json matches profile.ts
  extract              run the extraction pipeline (incremental)
  resolve              run resolvers in phase order
  survey               report the resolved/unresolved population
  status               store revision + row counts
`;

export async function runCli(argv: string[], cwd: string, overrides: TrestleConfig = {}): Promise<void> {
  const [command, sub] = argv;
  switch (command) {
    case "init":
      return init(cwd);
    case "profile": {
      if (sub === "build") return profileBuild(cwd, overrides, { write: true });
      if (sub === "check") return profileBuild(cwd, overrides, { write: false });
      throw new Error(`usage: trestle profile build|check`);
    }
    case "extract":
      return extract(cwd, overrides);
    case "resolve":
      return resolveCmd(cwd, overrides);
    case "survey":
      return survey(cwd, overrides);
    case "status":
      return status(cwd, overrides);
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

/** ---------- init ---------- */

function init(cwd: string): void {
  // Scaffold into ./trestle unless cwd already is a trestle dir.
  const target = existsSync(join(cwd, "trestle.config.ts")) ? cwd : join(cwd, "trestle");
  const manifest: Record<string, string> = existsSync(join(target, ".scaffold.json"))
    ? JSON.parse(readFileSync(join(target, ".scaffold.json"), "utf8"))
    : {};
  const written: string[] = [];
  for (const [rel, content] of Object.entries(TEMPLATES)) {
    const path = join(target, rel);
    if (existsSync(path)) continue; // never overwrite
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    manifest[rel] = sha256(content);
    written.push(rel);
  }
  mkdirSync(join(target, "units"), { recursive: true });
  writeFileSync(join(target, ".scaffold.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (written.length === 0) {
    console.log(`nothing to do: all scaffold files already exist in ${target}`);
  } else {
    console.log(`scaffolded ${relative(cwd, target) || "."}:`);
    for (const f of written) console.log(`  ${f}`);
    console.log(`\nnext: cd ${relative(cwd, target) || "."} && trestle profile build && trestle extract && trestle resolve && trestle survey`);
  }
}

/** ---------- profile ---------- */

async function loadAuthoredProfile(profilePath: string): Promise<Profile> {
  if (!existsSync(profilePath)) throw new Error(`profile not found: ${profilePath}`);
  // Cache-bust so repeated in-process builds see edits.
  const mod = await import(`${pathToFileURL(profilePath).href}?t=${Date.now()}`);
  const profile = mod.default as Profile;
  if (!profile || profile.__trestleProfile !== true) {
    throw new Error(`${profilePath}: default export is not a profile (use defineProfile from "trestle")`);
  }
  return profile;
}

async function profileBuild(cwd: string, overrides: TrestleConfig, opts: { write: boolean }): Promise<void> {
  const cfg = await loadConfig(cwd, overrides);
  const profile = await loadAuthoredProfile(cfg.profilePath);
  const lock = buildLock(profile);
  if (opts.write) {
    writeFileSync(cfg.lockPath, JSON.stringify(lock, null, 2) + "\n");
    console.log(`wrote ${relative(cwd, cfg.lockPath)} (profile ${lock.hash.slice(0, 12)})`);
    console.log(
      `  ${Object.keys(lock.profile.nodes).length} node kinds, ${Object.keys(lock.profile.edges).length} edge kinds, ${Object.keys(lock.profile.facts).length} fact kinds`,
    );
  } else {
    const existing = readLock(cfg.lockPath);
    if (!existing) throw new Error(`no lock file at ${cfg.lockPath}; run \`trestle profile build\``);
    if (existing.hash !== lock.hash) {
      throw new Error(
        `profile.lock.json is stale (lock ${existing.hash.slice(0, 12)}, profile.ts ${lock.hash.slice(0, 12)}); run \`trestle profile build\``,
      );
    }
    console.log(`profile.lock.json is up to date (${lock.hash.slice(0, 12)})`);
  }
}

function readLock(lockPath: string): ProfileLock | null {
  if (!existsSync(lockPath)) return null;
  return JSON.parse(readFileSync(lockPath, "utf8")) as ProfileLock;
}

/** ---------- stages ---------- */

async function openStore(cwd: string, overrides: TrestleConfig): Promise<{ store: Store; cfg: Awaited<ReturnType<typeof loadConfig>> }> {
  const cfg = await loadConfig(cwd, overrides);
  const lock = readLock(cfg.lockPath);
  if (!lock) throw new Error(`no profile lock at ${cfg.lockPath}; run \`trestle profile build\` first`);
  const store = new Store(cfg.dbPath);
  store.activateProfile(profileFromLock(lock), lock.hash);
  return { store, cfg };
}

async function extract(cwd: string, overrides: TrestleConfig): Promise<void> {
  const { store, cfg } = await openStore(cwd, overrides);
  try {
    if (!existsSync(cfg.pipelinePath)) throw new Error(`pipeline not found: ${cfg.pipelinePath}`);
    const mod = await import(pathToFileURL(cfg.pipelinePath).href);
    if (!isPipelineModule(mod.default)) {
      throw new Error(`${cfg.pipelinePath}: default export is not a pipeline (use pipeline() from "trestle")`);
    }
    const result = await runExtraction(store, mod.default, {
      corpusRoots: cfg.corpusRoots,
      stateDir: cfg.stateDir,
    });
    console.log(
      `extract @ rev ${result.rev}: ${result.cells.computed} cells computed, ${result.cells.skipped} skipped, ${result.cells.failed} failed; ` +
        `${result.facts.emitted} facts emitted, ${result.facts.retired} retired`,
    );
    for (const e of result.errors) console.error(`  cell ${e.cell}: ${e.error}`);
    if (result.cells.failed > 0) process.exitCode = 1;
  } finally {
    store.close();
  }
}

async function resolveCmd(cwd: string, overrides: TrestleConfig): Promise<void> {
  const { store, cfg } = await openStore(cwd, overrides);
  try {
    const resolvers = await loadResolvers(cfg.resolversDir);
    if (resolvers.length === 0) throw new Error(`no resolvers found in ${cfg.resolversDir}`);
    const results = await runResolvers(store, resolvers);
    for (const r of results) {
      const a = r.applied;
      console.log(
        `resolve ${r.resolver} (phase ${r.phase}) @ rev ${r.rev}: ` +
          `${a.node} nodes, ${a.edge} edges, ${a.alias} aliases, ${a.claim} claims, ${a.evidence} evidence, ${a.retired} retired` +
          (r.ignored > 0 ? `, ${r.ignored} ignored` : ""),
      );
    }
  } finally {
    store.close();
  }
}

async function survey(cwd: string, overrides: TrestleConfig): Promise<void> {
  const { store } = await openStore(cwd, overrides);
  try {
    console.log(renderSurvey(computeSurvey(store)));
  } finally {
    store.close();
  }
}

async function status(cwd: string, overrides: TrestleConfig): Promise<void> {
  const { store } = await openStore(cwd, overrides);
  try {
    const db = store.db;
    const count = (table: string): number =>
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE retired_rev IS NULL`).get() as { c: number }).c;
    console.log(`revision ${store.currentRevision()}`);
    console.log(`  facts: ${count("facts")}  nodes: ${count("nodes")}  edges: ${count("edges")}`);
    console.log(`  evidence: ${count("evidence")}  aliases: ${count("aliases")}  claims: ${count("claims")}`);
  } finally {
    store.close();
  }
}
