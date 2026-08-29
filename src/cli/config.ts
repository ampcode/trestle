import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface TrestleConfig {
  /** Corpus roots, relative to the config file's directory. Default: [".."]. */
  corpusRoots?: string[];
  /** State directory (gitignored). Default: ".state". */
  state?: string;
  profile?: string; // default "./profile.ts"
  profileLock?: string; // default "./profile.lock.json"
  pipeline?: string; // default "./extract/pipeline.ts"
  resolvers?: string; // default "./resolvers"
}

export interface ResolvedConfig {
  dir: string;
  corpusRoots: string[];
  stateDir: string;
  dbPath: string;
  profilePath: string;
  lockPath: string;
  pipelinePath: string;
  resolversDir: string;
}

export async function loadConfig(cwd: string, overrides: TrestleConfig = {}): Promise<ResolvedConfig> {
  // Accept either the trestle/ dir itself or a host repo containing trestle/.
  let dir = resolve(cwd);
  if (!existsSync(join(dir, "trestle.config.ts")) && existsSync(join(dir, "trestle", "trestle.config.ts"))) {
    dir = join(dir, "trestle");
  }
  const configPath = join(dir, "trestle.config.ts");
  let fileConfig: TrestleConfig = {};
  if (existsSync(configPath)) {
    const mod = await import(pathToFileURL(configPath).href);
    fileConfig = (mod.default ?? {}) as TrestleConfig;
  }
  const cfg = { ...fileConfig, ...overrides };
  const rel = (p: string): string => (isAbsolute(p) ? p : resolve(dir, p));
  const stateDir = rel(cfg.state ?? ".state");
  return {
    dir,
    corpusRoots: (cfg.corpusRoots ?? [".."]).map(rel),
    stateDir,
    dbPath: join(stateDir, "trestle.db"),
    profilePath: rel(cfg.profile ?? "./profile.ts"),
    lockPath: rel(cfg.profileLock ?? "./profile.lock.json"),
    pipelinePath: rel(cfg.pipeline ?? "./extract/pipeline.ts"),
    resolversDir: rel(cfg.resolvers ?? "./resolvers"),
  };
}
