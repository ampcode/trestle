import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { buildLock, isProfile, isProfileLock, profileFromLock, type Profile, type ProfileLock } from "../profile/define.ts";
import { sha256 } from "../profile/canonical.ts";
import { Store } from "../store/store.ts";
import { isPipelineModule } from "../extract/pipeline.ts";
import { runExtraction } from "../extract/run.ts";
import { hashDirSources } from "../extract/seed.ts";
import { loadResolvers, runResolvers } from "../resolve/run.ts";
import { computeSurvey, renderSurvey } from "../survey/survey.ts";
import { loadConfig, type TrestleConfig } from "./config.ts";


const USAGE = `trestle <command>

  corpus add <url>     add an estate under corpora/: git URL -> shallow
                       submodule (--ref <ref> pins a non-default ref);
                       archive URL (or --archive) -> fetched + extracted,
                       provenance in <name>.source.json (--sha256 verifies)
  corpus restore       refetch archive corpora from their manifests
  profile build        compile profile.ts -> profile.lock.json
  profile check        verify profile.lock.json matches profile.ts
  extract              run the extraction pipeline (incremental)
  resolve              run resolvers in phase order
  survey               report the resolved/unresolved population
  status               store revision + row counts
  doctor [--strict]    mechanical graph-health checks (duplication, staleness, drift)
  project build        materialize the Cypher projection (LadybugDB, regenerable)
  project query <q>    run a Cypher query against the projection
  serve [--port N] [--host H]
                       graph explorer + MCP server (POST /mcp);
                       expose through the orb portal
`;

export async function runCli(argv: string[], cwd: string, overrides: TrestleConfig = {}): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const [command, sub] = argv;
  switch (command) {
    case "corpus": {
      if (sub === "add") return corpusAdd(cwd, overrides, argv.slice(2));
      if (sub === "restore") return corpusRestore(cwd, overrides);
      throw new Error(`usage: trestle corpus add <git-url|archive-url> [name] [--ref <ref>] [--archive] [--sha256 <hash>] | trestle corpus restore`);
    }
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
    case "doctor":
      return doctor(cwd, overrides, argv.includes("--strict"));
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

/** ---------- corpus ---------- */

const ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".tar.bz2", ".tar.xz", ".tar", ".zip"];

interface CorpusSourceManifest {
  type: "archive";
  url: string;
  sha256: string;
}

function isCorpusSourceManifest(value: unknown): value is CorpusSourceManifest {
  return typeof value === "object" && value !== null
    && "type" in value && value.type === "archive"
    && "url" in value && typeof value.url === "string"
    && "sha256" in value && typeof value.sha256 === "string";
}

async function corpusAdd(cwd: string, overrides: TrestleConfig, args: string[]): Promise<void> {
  // Flags: --ref <ref> (git), --archive, --sha256 <hash> (archive).
  let ref: string | undefined;
  let archive = false;
  let expectedSha: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--ref") ref = args[++i];
    else if (a === "--archive") archive = true;
    else if (a === "--sha256") expectedSha = args[++i];
    else positional.push(a);
  }
  const [url, name] = positional;
  if (!url) throw new Error(`usage: trestle corpus add <git-url|archive-url> [name] [--ref <ref>] [--archive] [--sha256 <hash>]`);
  const isArchive = archive || ARCHIVE_SUFFIXES.some((s) => new URL(url, "file:///").pathname.endsWith(s));

  const base = url.replace(/\/+$/, "").split("/").pop() ?? "";
  const inferred = isArchive
    ? ARCHIVE_SUFFIXES.reduce((n, s) => (n.endsWith(s) ? n.slice(0, -s.length) : n), base)
    : base.replace(/\.git$/, "");
  const corpusName = name ?? inferred;
  if (!corpusName || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(corpusName)) {
    throw new Error(`cannot infer a corpus name from "${url}"; pass one: trestle corpus add <url> <name>`);
  }
  // Anchor at the graph repo root, into the first configured corpus root.
  const cfg = await loadConfig(cwd, overrides);
  const root = cfg.dir;
  const corpusRoot = relative(root, cfg.corpusRoots[0] ?? join(root, "corpora"));
  if (corpusRoot.startsWith("..")) throw new Error(`corpus root ${cfg.corpusRoots[0]} is outside the repo; cannot add a corpus there`);
  const path = join(corpusRoot, corpusName);
  if (existsSync(join(root, path))) throw new Error(`${path} already exists`);

  if (isArchive) {
    if (ref) throw new Error(`--ref applies only to git corpora`);
    const manifest = await acquireArchiveCorpus(url, join(root, path), expectedSha);
    // Tracked manifest = provenance; the extracted tree is ignored, like
    // submodule contents. `trestle corpus restore` refetches from it.
    const manifestPath = join(root, corpusRoot, `${corpusName}.source.json`);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    ensureIgnored(join(root, corpusRoot), corpusName);
    console.log(`added corpus ${path} (archive, sha256 ${manifest.sha256.slice(0, 12)}…)`);
    console.log(`next: git add ${relative(root, manifestPath)} ${join(corpusRoot, ".gitignore")} && git commit`);
    return;
  }

  // Shallow submodule: the pinned gitlink SHA is the corpus provenance.
  execFileSync("git", ["submodule", "add", "--depth", "1", url, path], { cwd: root, stdio: "inherit" });
  execFileSync("git", ["config", "-f", ".gitmodules", `submodule.${path}.shallow`, "true"], { cwd: root });
  if (ref) {
    // Pin a non-default ref (tag, branch, or SHA). Archived repos often
    // keep the application on a non-default branch.
    const sub = join(root, path);
    execFileSync("git", ["fetch", "--depth", "1", "origin", ref], { cwd: sub, stdio: "inherit" });
    execFileSync("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: sub, stdio: "inherit" });
  }
  console.log(`added corpus ${path} (shallow submodule, pinned by gitlink${ref ? ` at ${ref}` : ""})`);
  console.log(`next: git add .gitmodules ${path} && git commit`);
}

/** Download, verify, and extract an archive corpus. Returns its manifest. */
async function acquireArchiveCorpus(url: string, destDir: string, expectedSha?: string): Promise<CorpusSourceManifest> {
  console.log(`fetching ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actualSha = sha256(data);
  if (expectedSha && actualSha !== expectedSha) {
    throw new Error(`sha256 mismatch for ${url}\n  expected ${expectedSha}\n  actual   ${actualSha}`);
  }
  const tmp = mkdtempSync(join(tmpdir(), "trestle-corpus-"));
  const pathname = new URL(url, "file:///").pathname;
  const archivePath = join(tmp, pathname.split("/").pop() || "corpus-archive");
  writeFileSync(archivePath, data);
  mkdirSync(destDir, { recursive: true });
  try {
    if (archivePath.endsWith(".zip")) {
      execFileSync("unzip", ["-q", archivePath, "-d", destDir], { stdio: "inherit" });
    } else {
      execFileSync("tar", ["-xf", archivePath, "-C", destDir], { stdio: "inherit" });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { type: "archive", url, sha256: actualSha };
}

/** Re-fetch archive corpora whose extracted trees are missing (fresh clone). */
async function corpusRestore(cwd: string, overrides: TrestleConfig): Promise<void> {
  const cfg = await loadConfig(cwd, overrides);
  let restored = 0;
  for (const corpusRoot of cfg.corpusRoots) {
    if (!existsSync(corpusRoot)) continue;
    for (const entry of readdirSync(corpusRoot)) {
      if (!entry.endsWith(".source.json")) continue;
      const name = entry.slice(0, -".source.json".length);
      const dest = join(corpusRoot, name);
      if (existsSync(dest)) {
        console.log(`corpus ${name}: present, skipping`);
        continue;
      }
      const manifest: unknown = JSON.parse(readFileSync(join(corpusRoot, entry), "utf8"));
      if (!isCorpusSourceManifest(manifest)) throw new Error(`${entry}: invalid archive corpus source manifest`);
      await acquireArchiveCorpus(manifest.url, dest, manifest.sha256);
      console.log(`restored corpus ${relative(cfg.dir, dest)} (sha256 verified)`);
      restored++;
    }
  }
  console.log(restored === 0 ? `nothing to restore (git corpora: git submodule update --init --depth 1)` : `${restored} corpus(es) restored`);
}

/** Ensure <name>/ is git-ignored inside the corpus root (extracted trees are not committed). */
function ensureIgnored(corpusRootAbs: string, name: string): void {
  const gitignore = join(corpusRootAbs, ".gitignore");
  const line = `${name}/`;
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (existing.split("\n").some((l) => l.trim() === line)) return;
  writeFileSync(gitignore, existing + (existing.endsWith("\n") || existing === "" ? "" : "\n") + line + "\n");
}

/** ---------- profile ---------- */

async function loadAuthoredProfile(profilePath: string): Promise<Profile> {
  if (!existsSync(profilePath)) throw new Error(`profile not found: ${profilePath}`);
  // Cache-bust so repeated in-process builds see edits.
  const mod = await import(`${pathToFileURL(profilePath).href}?t=${Date.now()}`);
  const profile: unknown = mod.default;
  if (!isProfile(profile)) {
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
  const lock: unknown = JSON.parse(readFileSync(lockPath, "utf8"));
  if (!isProfileLock(lock)) throw new Error(`invalid profile lock at ${lockPath}`);
  return lock;
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
    const before = liveCounts(store);
    const results = await runResolvers(store, resolvers);
    for (const r of results) {
      const a = r.applied;
      console.log(
        `resolve ${r.resolver} (phase ${r.phase}) @ rev ${r.rev} — directives applied: ` +
          `${a.node} node, ${a.edge} edge, ${a.alias} alias, ${a.claim} claim, ${a.evidence} evidence, ${a.retired} retired` +
          (r.ignored > 0 ? `, ${r.ignored} ignored` : ""),
      );
    }
    // Directive counts read as churn even when the pass is a semantic no-op
    // (each resolver retires + reapplies its own provenance). The live-row
    // delta is the idempotency signal.
    const after = liveCounts(store);
    // SAFETY: liveCounts constructs exactly these six own keys, with no external object spread.
    const deltas = (Object.keys(after) as (keyof typeof after)[])
      .filter((k) => after[k] !== before[k])
      .map((k) => `${k} ${after[k] - before[k] > 0 ? "+" : ""}${after[k] - before[k]}`);
    console.log(deltas.length === 0 ? `live graph unchanged` : `live graph delta: ${deltas.join(", ")}`);
  } finally {
    store.close();
  }
}

function liveCounts(store: Store): Record<"facts" | "nodes" | "edges" | "evidence" | "claims" | "aliases", number> {
  const count = (table: string): number =>
    // SAFETY: COUNT returns one numeric c column in SQLite's default integer mode.
    (store.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE retired_rev IS NULL`).get() as { c: number }).c;
  return {
    facts: count("facts"),
    nodes: count("nodes"),
    edges: count("edges"),
    evidence: count("evidence"),
    claims: count("claims"),
    aliases: count("aliases"),
  };
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
  const { startServer, TOOLS } = await import("../server/serve.ts");
  const cfg = await loadConfig(cwd, overrides);
  let port = 7331;
  let host = "127.0.0.1";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port") port = Number(args[++i]);
    else if (args[i] === "--host") host = String(args[++i]);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid --port`);
  const running = await startServer(
    { dbPath: cfg.dbPath, projectionPath: cfg.projectionPath, lockPath: cfg.lockPath, visualization: cfg.visualization },
    { port, host },
  );
  console.log(`trestle graph server on http://${host}:${running.port} (visualization /; MCP POST /mcp)`);
  console.log(`  tools: ${TOOLS.map((t) => t.name).join(", ")}`);
  console.log(`  expose it: amp orb portal ${running.port}`);
  // Run until terminated; the supervisor (amp orb service) owns the lifecycle.
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await running.close();
}

async function doctor(cwd: string, overrides: TrestleConfig, strict: boolean): Promise<void> {
  const { runDoctor, renderDoctor } = await import("../check/doctor.ts");
  const { store } = await openStore(cwd, overrides);
  try {
    const report = runDoctor(store);
    console.log(renderDoctor(report));
    if (strict && report.errors > 0) throw new Error(`doctor --strict: ${report.errors} error check(s) failing`);
  } finally {
    store.close();
  }
}

async function status(cwd: string, overrides: TrestleConfig): Promise<void> {
  const { store } = await openStore(cwd, overrides);
  try {
    const db = store.db;
    const count = (table: string): number =>
      // SAFETY: COUNT returns one numeric c column in SQLite's default integer mode.
      (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE retired_rev IS NULL`).get() as { c: number }).c;
    console.log(`revision ${store.currentRevision()}`);
    console.log(`  facts: ${count("facts")}  nodes: ${count("nodes")}  edges: ${count("edges")}`);
    console.log(`  evidence: ${count("evidence")}  aliases: ${count("aliases")}  claims: ${count("claims")}`);
  } finally {
    store.close();
  }
}
