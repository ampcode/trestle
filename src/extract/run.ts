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
  /**
   * Open a corpus file once and return its bytes.
   *
   * Reading and hashing are fused deliberately. Every read has to be hashed
   * for the cell fingerprint, and on estates large enough to matter the file
   * open dominates everything else — a mainframe corpus is 138,000 members
   * against a filesystem doing on the order of a hundred opens a second, so
   * hashing from a second read would double the cost of extraction.
   *
   * Locating the file is fused for the same reason: probing each root with
   * `existsSync` and then opening the winner is one syscall more than trying
   * the open and moving on when it fails.
   */
  const openCorpusFile = (path: string): { abs: string; bytes: Buffer } => {
    const candidates = isAbsolute(path) ? [path] : roots.map((root) => join(root, path));
    for (const abs of candidates) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(abs);
      } catch (err) {
        // Only a genuinely absent file means "try the next root"; anything
        // else (permissions, a directory, I/O failure) is a real error and
        // must not be reported as a missing corpus path.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (!hashCache.has(abs)) hashCache.set(abs, sha256(bytes));
      return { abs, bytes };
    }
    throw new Error(
      isAbsolute(path)
        ? `corpus.read: not found: ${path}`
        : `corpus.read: "${path}" not found under corpus roots [${roots.join(", ")}]`,
    );
  };

  // Cell fingerprint = seed (pipeline code + profile) + recorded file reads.
  // Nothing else may enter it: the probe must be able to recompute the exact
  // committed fingerprint without executing the cell, so any input that only
  // exists during execution (e.g. run() invocations) would make tool-backed
  // cells miss forever. Tool/arg changes are covered by the seed, which
  // hashes the pipeline source that constructs them.
  const cellFingerprint = (name: string, reads: [path: string, hash: string][], priorInputCount: number): string =>
    sha256(JSON.stringify([seed, name, [...reads].sort(), priorInputCount]));

  // ---- state shared across primitives ----
  let currentCell: string | null = null;
  let cellReads: Map<string, string> | null = null; // path -> content hash
  let cellFacts: FactInput[] = [];
  const rootFacts: FactInput[] = [];
  const seenCells = new Set<string>();

  /** Content hash of a corpus path. Throws if it cannot be opened. */
  const contentHash = (path: string): string => hashCache.get(openCorpusFile(path).abs)!;

  /** Read a corpus file and record it against the running cell. */
  const readAndRecord = (path: string): Buffer => {
    const { abs, bytes } = openCorpusFile(path);
    const h = hashCache.get(abs)!;
    store.recordArtifact(path, h, "corpus", rev);
    if (cellReads) cellReads.set(path, h);
    return bytes;
  };

  /** Record a declared cell input without needing its bytes. */
  const recordRead = (path: string): void => {
    const h = contentHash(path);
    store.recordArtifact(path, h, "corpus", rev);
    if (cellReads) cellReads.set(path, h);
  };

  const corpus: Corpus = {
    list(filter) {
      const out: string[] = [];
      for (const root of roots) {
        if (!existsSync(root)) continue; // e.g. corpora/ before any corpus is added
        walk(root, root, out);
      }
      out.sort();
      if (filter === undefined) return out;
      if (typeof filter === "string") return out.filter((p) => p.endsWith(filter));
      return out.filter((p) => filter.test(p));
    },
    read(path, encoding = "utf8") {
      return readAndRecord(path).toString(encoding);
    },
    readBytes(path) {
      return readAndRecord(path);
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
          probe.set(p, contentHash(p));
        } catch {
          probeFailed = true; // an input disappeared; recompute
        }
      }
      const fingerprint = cellFingerprint(name, [...probe.entries()], prior?.inputs.length ?? -1);
      if (prior && !probeFailed && prior.fingerprint === fingerprint) {
        result.cells.skipped++;
        return { skipped: true };
      }

      currentCell = name;
      cellReads = new Map();
      cellFacts = [];
      for (const p of inputs) recordRead(p); // declared inputs always count
      try {
        await fn();
        // Commit: retire predecessor facts, insert new, store fingerprint over *actual* reads.
        result.facts.retired += store.retireFactsByCell(name, rev);
        for (const f of cellFacts) {
          store.insertFact(f, name, rev);
          result.facts.emitted++;
        }
        const actualInputs = [...cellReads.entries()].map(([path, hash]) => ({ path, hash }));
        // Committed with the same function the probe uses; count = actual
        // input count so the next probe (which passes prior.inputs.length)
        // reproduces it exactly when nothing changed.
        const actualFingerprint = cellFingerprint(
          name,
          actualInputs.map((i) => [i.path, i.hash]),
          actualInputs.length,
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
        return { stdout, stderr: "", status: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; status?: number; message: string };
        if (e.status !== undefined && e.status !== null) {
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
