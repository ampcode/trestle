import type { FactInput } from "../store/store.ts";

export interface Corpus {
  /** Corpus-relative paths, sorted. Optional filter is a RegExp or suffix string. */
  list(filter?: RegExp | string): string[];
  /**
   * Read as text. Every read is recorded; content hashes feed cache keys.
   * Defaults to UTF-8; pass "latin1" for legacy estates whose sources
   * predate UTF-8 (UTF-8 decoding would insert replacement characters).
   */
  read(path: string, encoding?: "utf8" | "latin1"): string;
  readBytes(path: string): Uint8Array;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface PipelineCtx {
  corpus: Corpus;
  /**
   * Incremental cell. `inputs` are corpus paths; reads made inside `fn`
   * are also recorded. Unchanged fingerprint skips the body; a recomputed
   * cell retires the facts its predecessor emitted.
   */
  memo(name: string, inputs: string[], fn: () => void | Promise<void>): Promise<{ skipped: boolean }>;
  /** Invoke an external tool; command + args + declared inputs join the cell fingerprint. */
  run(tool: string, args: string[], opts?: { cwd?: string; input?: string }): RunResult;
  /**
   * Fetch a remote input once and freeze it as an immutable snapshot
   * artifact under .state/artifacts/<name>. Returns the absolute path.
   * The only primitive allowed to touch the network.
   */
  acquire(name: string, fetch: () => Promise<Uint8Array | string>): Promise<string>;
  /** Write facts to the fact store (schema-validated at the write boundary). */
  emit(fact: FactInput | FactInput[]): void;
}

export type PipelineFn = (ctx: PipelineCtx) => void | Promise<void>;

export interface PipelineModule {
  __trestlePipeline: true;
  fn: PipelineFn;
}

export function pipeline(fn: PipelineFn): PipelineModule {
  return { __trestlePipeline: true, fn };
}

export function isPipelineModule(v: unknown): v is PipelineModule {
  return typeof v === "object" && v !== null && "__trestlePipeline" in v && v.__trestlePipeline === true;
}
