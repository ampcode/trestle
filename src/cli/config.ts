import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface VisualizationNodeStyle {
  /** Identity or property field used as the node label. Defaults to the identity tuple. */
  label?: string;
  /** CSS hex color. Defaults to a stable color derived from the node kind. */
  color?: string;
  /** Relative rendered size. Default: 1. */
  size?: number;
  /** Hide this kind when the visualization first opens. */
  hidden?: boolean;
}

export interface VisualizationEdgeStyle {
  /** CSS hex color. Defaults to a stable color derived from the edge kind. */
  color?: string;
  /** Relative rendered width. Default: 1. */
  width?: number;
  /** Hide this kind when the visualization first opens. */
  hidden?: boolean;
}

export interface VisualizationConfig {
  title?: string;
  nodes?: Record<string, VisualizationNodeStyle>;
  edges?: Record<string, VisualizationEdgeStyle>;
}

export interface TrestleConfig {
  /** Corpus roots, relative to the config file's directory. Default: ["corpora"]. */
  corpusRoots?: string[];
  /** State directory (gitignored). Default: ".state". */
  state?: string;
  profile?: string; // default "./profile.ts"
  profileLock?: string; // default "./profile.lock.json"
  pipeline?: string; // default "./extract/pipeline.ts"
  resolvers?: string; // default "./resolvers"
  /** Browser graph presentation. Data always comes from the live SQLite store. */
  visualization?: VisualizationConfig;
}

export interface ResolvedConfig {
  dir: string;
  corpusRoots: string[];
  stateDir: string;
  dbPath: string;
  projectionPath: string;
  profilePath: string;
  lockPath: string;
  pipelinePath: string;
  resolversDir: string;
  visualization: VisualizationConfig;
}

export async function loadConfig(cwd: string, overrides: TrestleConfig = {}): Promise<ResolvedConfig> {
  // The graph repo root is wherever trestle.config.ts lives. Search upward
  // so the CLI works from any subdirectory; stop at a git boundary so an
  // unrelated parent project is never picked up.
  let dir = resolve(cwd);
  for (let d = dir; ; ) {
    if (existsSync(join(d, "trestle.config.ts"))) {
      dir = d;
      break;
    }
    if (existsSync(join(d, ".git"))) break; // repo root without a config: stay at cwd
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
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
    corpusRoots: (cfg.corpusRoots ?? ["corpora"]).map(rel),
    stateDir,
    dbPath: join(stateDir, "trestle.db"),
    projectionPath: join(stateDir, "projection.lbug"),
    profilePath: rel(cfg.profile ?? "./profile.ts"),
    lockPath: rel(cfg.profileLock ?? "./profile.lock.json"),
    pipelinePath: rel(cfg.pipeline ?? "./extract/pipeline.ts"),
    resolversDir: rel(cfg.resolvers ?? "./resolvers"),
    visualization: cfg.visualization ?? {},
  };
}
