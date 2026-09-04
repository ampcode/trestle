import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256 } from "../profile/canonical.ts";

/**
 * Build output and dependency trees that a pipeline's own tooling creates
 * beside its sources. These are derived from the very files already being
 * hashed, so including them adds nothing — and they are written *while the
 * pipeline runs*, which is worse than useless: the first run of a Python
 * helper leaves `__pycache__` behind, the next run hashes a directory that
 * did not exist before, the seed changes, and every memo cell misses. The
 * symptom is a pipeline that never skips anything and no visible cause.
 */
const DERIVED_DIRS = new Set([
  "__pycache__",
  ".venv",
  "venv",
  "node_modules",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".gradle",
  "target",
]);

/** Compiled artifacts that appear next to the sources they came from. */
const DERIVED_FILE = /\.(pyc|pyo|class|o|so|dylib|dll)$/;

/**
 * Content hash of every source file under a directory (recursive, sorted).
 *
 * This is the extraction fingerprint seed: editing anything it covers
 * invalidates every memo cell. All *source* files count, not just `.ts` —
 * pipelines shell out to helper tools (`extract/tools/*.java`, scripts,
 * grammars) whose edits must invalidate cells just as pipeline code does.
 * Derived output is excluded; see {@link DERIVED_DIRS} for why that matters
 * more than it sounds.
 */
export function hashDirSources(dir: string): string {
  const entries: [string, string][] = [];
  const walk = (d: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!DERIVED_DIRS.has(e.name)) walk(join(d, e.name));
      } else if (e.isFile() && !DERIVED_FILE.test(e.name)) {
        const p = join(d, e.name);
        entries.push([relative(dir, p), sha256(readFileSync(p))]);
      }
    }
  };
  walk(dir);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return sha256(JSON.stringify(entries));
}
