import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  skills list          list packaged agent skills
  skills get <name>    print a packaged skill (version-matched to this install)
  project build        materialize the Cypher projection (LadybugDB, regenerable)
  project query <q>    run a Cypher query against the projection
  serve [--port N]     MCP server over HTTP (graph_query, survey, status);
                       expose through the orb portal for other threads
`;

export async function runCli(argv: string[], cwd: string, overrides: TrestleConfig = {}): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
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
    case "skills": {
      if (sub === "list") return skillsList();
      if (sub === "get") return skillsGet(argv[2]);
      throw new Error(`usage: trestle skills list|get <name>`);
    }
    case "project": {
      if (sub === "build") return projectBuild(cwd, overrides);
      if (sub === "query") return projectQuery(cwd, overrides, argv[2]);
      throw new Error(`usage: trestle project build|query <cypher>`);
    }
    case "serve":
      return serve(cwd, overrides, argv.slice(1));
    case undefined:
    case "help":
    case "--help":
      console.log(USAGE);
      return;
    default:
      throw new Error(`unknown command "${command}"\n\n${USAGE}`);
  }
}

/** ---------- packaged skills ---------- */

const SKILLS_DIR = join(import.meta.dirname, "../../skills");

interface PackagedSkill {
  name: string;
  description: string;
  content: string;
}

function packagedSkills(): PackagedSkill[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
    .map((e) => {
      const content = readFileSync(join(SKILLS_DIR, e.name, "SKILL.md"), "utf8");
      const description = /^description:\s*(.+)$/m.exec(content)?.[1]?.trim() ?? "";
      return { name: e.name, description, content };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function skillsList(): void {
  for (const s of packagedSkills()) console.log(`${s.name}\n    ${s.description}`);
}

function skillsGet(name: string | undefined): void {
  const skills = packagedSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    throw new Error(`unknown skill "${name ?? ""}" (available: ${skills.map((s) => s.name).join(", ")})`);
  }
  console.log(skill.content);
}

/** ---------- init ---------- */

function skillStub(s: PackagedSkill): string {
  return `---
name: ${s.name}
description: ${s.description}
---

# ${s.name}

Read the full, version-matched instructions from the installed trestle
package before doing this work: \`node_modules/trestle/skills/${s.name}/SKILL.md\`
(or run \`npx trestle skills get ${s.name}\`).

## Project addenda

(add project-specific conventions for this topic here)
`;
}

function init(cwd: string): void {
  // Scaffold into ./trestle unless cwd already is a trestle dir.
  const target = existsSync(join(cwd, "trestle.config.ts")) ? cwd : join(cwd, "trestle");
  const manifest: Record<string, string> = existsSync(join(target, ".scaffold.json"))
    ? JSON.parse(readFileSync(join(target, ".scaffold.json"), "utf8"))
    : {};
  const written: string[] = [];
  const scaffoldFile = (rel: string, content: string): void => {
    const path = join(target, rel);
    if (existsSync(path)) return; // never overwrite
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    manifest[rel] = sha256(content);
    written.push(rel);
  };
  for (const [rel, content] of Object.entries(TEMPLATES)) scaffoldFile(rel, content);
  // Host-level skill stubs: point at the packaged, version-matched skills
  // and carry project addenda. Host root is the scaffold dir's parent.
  for (const s of packagedSkills()) {
    scaffoldFile(join("..", ".agents", "skills", s.name, "SKILL.md"), skillStub(s));
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

/** Content hash of all .ts sources under a directory (recursive, sorted). */
function hashDirSources(dir: string): string {
  const entries: [string, string][] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".ts")) entries.push([relative(dir, p), sha256(readFileSync(p))]);
    }
  };
  walk(dir);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return sha256(JSON.stringify(entries));
}

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
      // Editing pipeline code (anything under extract/) or the profile
      // invalidates every cell.
      fingerprintSeed: hashDirSources(dirname(cfg.pipelinePath)) + store.profileHash(),
    });
    console.log(
      `extract @ rev ${result.rev}: ${result.cells.computed} cells computed, ${result.cells.skipped} skipped, ${result.cells.failed} failed` +
        (result.cells.stale > 0 ? `, ${result.cells.stale} stale retired` : "") +
        `; ${result.facts.emitted} facts emitted, ${result.facts.retired} retired`,
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
        `resolve ${r.resolver} (phase ${r.phase}) @ rev ${r.rev} — directives applied: ` +
          `${a.node} node, ${a.edge} edge, ${a.alias} alias, ${a.claim} claim, ${a.evidence} evidence, ${a.retired} retired` +
          (r.ignored > 0 ? `, ${r.ignored} ignored` : ""),
      );
    }
    console.log(`(directive counts, not live rows — see \`trestle status\`)`);
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

async function projectBuild(cwd: string, overrides: TrestleConfig): Promise<void> {
  const { buildProjection } = await import("../project/ladybug.ts");
  const { store, cfg } = await openStore(cwd, overrides);
  try {
    const r = await buildProjection(store, cfg.projectionPath);
    console.log(
      `projection @ ${relative(cwd, r.path)}: ${r.nodeTables} node tables, ${r.relTables} rel tables; ` +
        `${r.nodes} nodes, ${r.edges} edges`,
    );
  } finally {
    store.close();
  }
}

async function projectQuery(cwd: string, overrides: TrestleConfig, cypher: string | undefined): Promise<void> {
  if (!cypher) throw new Error(`usage: trestle project query '<cypher>'`);
  const { queryProjection } = await import("../project/ladybug.ts");
  const cfg = await loadConfig(cwd, overrides);
  const rows = await queryProjection(cfg.projectionPath, cypher);
  console.log(JSON.stringify(rows, null, 2));
}

async function serve(cwd: string, overrides: TrestleConfig, args: string[]): Promise<void> {
  const { startServer } = await import("../server/serve.ts");
  const cfg = await loadConfig(cwd, overrides);
  if (!existsSync(cfg.lockPath)) throw new Error(`no profile lock at ${cfg.lockPath}; run \`trestle profile build\` first`);
  let port = 7331;
  let host = "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--host") host = String(args[++i]);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port`);
  const running = await startServer(
    { dbPath: cfg.dbPath, projectionPath: cfg.projectionPath, lockPath: cfg.lockPath },
    { port, host },
  );
  console.log(`trestle MCP server on http://${host}:${running.port} (POST JSON-RPC; GET /health)`);
  console.log(`  tools: graph_query, survey, status`);
  console.log(`  expose it: amp orb portal ${running.port}`);
  // Run until terminated; the supervisor (amp orb service) owns the lifecycle.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await running.close();
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
