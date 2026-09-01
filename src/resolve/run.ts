import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Store } from "../store/store.ts";
import { isResolverModule, makeEmitter, makeSlice, type ResolverModule } from "./sdk.ts";

export interface ResolveResult {
  resolver: string;
  phase: number;
  rev: number;
  applied: Record<string, number>;
  ignored: number;
}

export async function loadResolvers(dir: string): Promise<ResolverModule[]> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    throw new Error(`resolvers directory not found: ${dir}`);
  }
  const modules: ResolverModule[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".ts") && !entry.endsWith(".js")) continue;
    if (entry.startsWith("_") || entry.endsWith(".test.ts")) continue;
    const mod = await import(pathToFileURL(join(dir, entry)).href);
    const def = mod.default;
    if (!isResolverModule(def)) {
      throw new Error(`${entry}: default export is not a resolver (use resolver({ ... }) from "trestle")`);
    }
    modules.push(def);
  }
  return modules;
}

/** Run resolvers in phase order; each application is one revision. */
export async function runResolvers(store: Store, resolvers: ResolverModule[]): Promise<ResolveResult[]> {
  const ordered = [...resolvers].sort((a, b) => a.phase - b.phase || a.name.localeCompare(b.name));
  // A renamed or deleted resolver never runs again, so nothing retires its
  // prior contribution. Sweep before the pass: abandoned output vanishes
  // first, and a renamed resolver re-declares its graph under the new name.
  store.retireAbandonedOwners(ordered.map((d) => d.name));
  const results: ResolveResult[] = [];
  for (const def of ordered) {
    const slice = makeSlice({
      factsByKind: (k) => store.factsByKind(k),
      liveNodes: (k) => store.liveNodes(k),
      liveEdges: (k) => store.liveEdges(k),
      liveEvidenceFor: (stableId) => store.liveEvidenceFor(stableId),
      consumedFacts: def.consumes?.facts,
    });
    const { emit, output } = makeEmitter();
    await def.run(slice, emit);
    const { rev, applied } = store.applyDirectives(def.name, def.version ?? "0", output.directives);
    results.push({ resolver: def.name, phase: def.phase, rev, applied, ignored: output.ignored.length });
  }
  return results;
}
