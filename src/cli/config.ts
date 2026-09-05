import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isString } from "../profile/value.ts";

export interface VisualizationNodeStyle {
  /** Identity or property field used as the node label. Defaults to the identity tuple. */
  label?: string;
  /** CSS color used as the G6VP default for this kind. */
  color?: string;
  /** Relative rendered size. Default: 1. */
  size?: number;
  /** Exclude this kind from the G6VP canvas. */
  hidden?: boolean;
}

export interface VisualizationEdgeStyle {
  /** CSS color used as the G6VP default for this kind. */
  color?: string;
  /** G6VP line thickness. */
  width?: number;
  /** Exclude this kind from the G6VP canvas. */
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

function isNodeStyle(value: unknown): value is VisualizationNodeStyle {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (!("label" in value) || value.label === undefined || typeof value.label === "string")
    && (!("color" in value) || value.color === undefined || typeof value.color === "string")
    && (!("size" in value) || value.size === undefined || typeof value.size === "number")
    && (!("hidden" in value) || value.hidden === undefined || typeof value.hidden === "boolean");
}

function isEdgeStyle(value: unknown): value is VisualizationEdgeStyle {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (!("color" in value) || value.color === undefined || typeof value.color === "string")
    && (!("width" in value) || value.width === undefined || typeof value.width === "number")
    && (!("hidden" in value) || value.hidden === undefined || typeof value.hidden === "boolean");
}

function isVisualizationConfig(value: unknown): value is VisualizationConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (!("title" in value) || value.title === undefined || typeof value.title === "string")
    && (!("nodes" in value) || value.nodes === undefined || (typeof value.nodes === "object" && value.nodes !== null
      && !Array.isArray(value.nodes) && Object.values(value.nodes).every(isNodeStyle)))
    && (!("edges" in value) || value.edges === undefined || (typeof value.edges === "object" && value.edges !== null
      && !Array.isArray(value.edges) && Object.values(value.edges).every(isEdgeStyle)));
}

function isConfig(value: unknown): value is TrestleConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return (!("state" in value) || value.state === undefined || isString(value.state))
    && (!("profile" in value) || value.profile === undefined || isString(value.profile))
    && (!("profileLock" in value) || value.profileLock === undefined || isString(value.profileLock))
    && (!("pipeline" in value) || value.pipeline === undefined || isString(value.pipeline))
    && (!("resolvers" in value) || value.resolvers === undefined || isString(value.resolvers))
    && (!("corpusRoots" in value) || value.corpusRoots === undefined || (Array.isArray(value.corpusRoots)
      && value.corpusRoots.every(isString)))
    && (!("visualization" in value) || value.visualization === undefined || isVisualizationConfig(value.visualization));
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
    const exported: unknown = mod.default ?? {};
    if (!isConfig(exported)) throw new Error(`${configPath}: invalid Trestle configuration`);
    fileConfig = exported;
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
