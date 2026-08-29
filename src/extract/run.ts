import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sha256 } from "../profile/canonical.ts";
import type { FactInput, Store } from "../store/store.ts";
import type { Corpus, PipelineCtx, PipelineModule, RunResult } from "./pipeline.ts";

const SKIP_DIRS = new Set([".git", "node_modules", ".state", "dist"]);
const ROOT_CELL = "__root__";

export interface ExtractResult {
  rev: number;
  cells: { computed: number; skipped: number; failed: number; stale: number };
  facts: { emitted: number; retired: number };
  errors: { cell: string; error: string }[];
}

export async function runExtraction(
  store: Store,
  pipelineDef: PipelineModule,
  opts: {
    corpusRoots: string[];
    stateDir: string;
    /**
     * Joins every cell fingerprint. Callers pass a hash of the pipeline
     * code + profile so editing either recomputes all cells (the CLI hashes
     * the extract/ directory and the profile lock).
     */
    fingerprintSeed?: string;
  },
): Promise<ExtractResult> {
  store.requireProfile();
  const roots = opts.corpusRoots.map((r) => resolve(r));
  const seed = opts.fingerprintSeed ?? "";
  const rev = store.beginRevision("extract", {});
  const result: ExtractResult = {
    rev,
    cells: { computed: 0, skipped: 0, failed: 0, stale: 0 },
    facts: { emitted: 0, retired: 0 },
    errors: [],
  };

  const hashCache = new Map<string, string>();
  const contentHash = (absPath: string): string => {
    let h = hashCache.get(absPath);
    if (!h) {
      h = sha256(readFileSync(absPath));
      hashCache.set(absPath, h);
    }
    return h;
  };
  const findAbs = (path: string): string => {
    if (isAbsolute(path)) {
      if (existsSync(path)) return path; // acquired artifacts
      throw new Error(`corpus.read: not found: ${path}`);
    }
    for (const root of roots) {
      const abs = join(root, path);
      if (existsSync(abs)) return abs;
    }
    throw new Error(`corpus.read: "${path}" not found under corpus roots [${roots.join(", ")}]`);
  };

  // ---- state shared across primitives ----
  let currentCell: string | null = null;
  let cellReads: Map<string, string> | null = null; // path -> content hash
  let cellExtras: string[] | null = null; // non-file fingerprint inputs (run invocations)
  let cellFacts: FactInput[] = [];
  const rootFacts: FactInput[] = [];
  const seenCells = new Set<string>();

  const recordRead = (path: string, abs: string): void => {
    const h = contentHash(abs);
    store.recordArtifact(path, h, "corpus", rev);
    if (cellReads) cellReads.set(path, h);
  };

  const corpus: Corpus = {
    list(filter) {
      const out: string[] = [];
      for (const root of roots) {
        walk(root, root, out);
      }
      out.sort();
      if (filter === undefined) return out;
      if (typeof filter === "string") return out.filter((p) => p.endsWith(filter));
      return out.filter((p) => filter.test(p));
    },
    read(path) {
      const abs = findAbs(path);
      recordRead(path, abs);
      return readFileSync(abs, "utf8");
    },
    readBytes(path) {
      const abs = findAbs(path);
      recordRead(path, abs);
      return readFileSync(abs);
    },
  };

  const ctx: PipelineCtx = {
    corpus,
    async memo(name, inputs, fn) {
      if (currentCell !== null) throw new Error(`memo("${name}"): memo cells cannot nest`);
      seenCells.add(name);
      // Fingerprint = seed (pipeline code + profile) + declared inputs +
      // last run's recorded reads, hashed now.
      const prior = store.getMemoCell(name);
      const probe = new Map<string, string>();
      let probeFailed = false;
      for (const p of new Set([...inputs, ...(prior?.inputs.map((i) => i.path) ?? [])])) {
        try {
          probe.set(p, contentHash(findAbs(p)));
        } catch {
          probeFailed = true; // an input disappeared; recompute
        }
      }
      const fingerprint = sha256(
        JSON.stringify([seed, name, [...probe.entries()].sort(), prior?.inputs.length ?? -1]),
      );
      if (prior && !probeFailed && prior.fingerprint === fingerprint) {
        result.cells.skipped++;
        return { skipped: true };
      }

      currentCell = name;
      cellReads = new Map();
      cellExtras = [];
      cellFacts = [];
      for (const p of inputs) recordRead(p, findAbs(p)); // declared inputs always count
      try {
        await fn();
        // Commit: retire predecessor facts, insert new, store fingerprint over *actual* reads.
        result.facts.retired += store.retireFactsByCell(name, rev);
        for (const f of cellFacts) {
          store.insertFact(f, name, rev);
          result.facts.emitted++;
        }
        const actualInputs = [...cellReads.entries()].map(([path, hash]) => ({ path, hash }));
        const actualFingerprint = sha256(
          JSON.stringify([seed, name, actualInputs.map((i) => [i.path, i.hash]).sort(), actualInputs.length, ...cellExtras]),
        );
        store.putMemoCell(name, actualFingerprint, actualInputs, rev);
        result.cells.computed++;
      } catch (err) {
        // A crashing cell fails that cell, not the run; predecessor facts are kept.
        result.cells.failed++;
        result.errors.push({ cell: name, error: err instanceof Error ? err.message : String(err) });
      } finally {
        currentCell = null;
        cellReads = null;
        cellExtras = null;
        cellFacts = [];
      }
      return { skipped: false };
    },
    run(tool, args, runOpts): RunResult {
      try {
        const stdout = execFileSync(tool, args, {
          cwd: runOpts?.cwd,
          input: runOpts?.input,
          encoding: "utf8",
          maxBuffer: 512 * 1024 * 1024,
        });
        cellExtras?.push(`run:${tool}:${JSON.stringify(args)}`);
        return { stdout, stderr: "", status: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number; message: string };
        if (e.status !== undefined && e.status !== null) {
          cellExtras?.push(`run:${tool}:${JSON.stringify(args)}`);
          return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status };
        }
        throw new Error(`run(${tool}): ${e.message}`);
      }
    },
    async acquire(name, fetch) {
      const dir = join(opts.stateDir, "artifacts");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      if (!existsSync(path)) {
        const data = await fetch();
        writeFileSync(path, data);
      }
      // Frozen snapshot: record, never refetch. Delete the file to refresh.
      store.recordArtifact(relative(opts.stateDir, path), contentHash(path), "acquired", rev);
      return path;
    },
    emit(factOrFacts) {
      const facts = Array.isArray(factOrFacts) ? factOrFacts : [factOrFacts];
      if (currentCell !== null) cellFacts.push(...facts);
      else rootFacts.push(...facts);
    },
  };

  await pipelineDef.fn(ctx);

  // Root-level emissions behave like a cell recomputed every run.
  result.facts.retired += store.retireFactsByCell(ROOT_CELL, rev);
  for (const f of rootFacts) {
    store.insertFact(f, ROOT_CELL, rev);
    result.facts.emitted++;
  }

  // Stale cells: memo cells the pipeline no longer invokes (renamed keys,
  // deleted files, removed loops). Retire their facts so they don't linger
  // as live duplicates. Skipped only when cells failed — a crashed cell
  // never registers as seen, and retiring its facts would be destructive.
  if (result.cells.failed === 0) {
    for (const key of store.listMemoCellKeys()) {
      if (seenCells.has(key)) continue;
      result.facts.retired += store.retireFactsByCell(key, rev);
      store.deleteMemoCell(key);
      result.cells.stale++;
    }
  }

  return result;
}

function walk(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile()) out.push(relative(root, abs));
  }
}
