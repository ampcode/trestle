/**
 * `trestle serve`: the project's query endpoint (docs/architecture.md §5/§7).
 *
 * A browser graph-analysis canvas and MCP server, meant to run as one supervised
 * service inside the project orb and be exposed through the orb portal.
 *
 * HTTP: GET / is the explorer, GET /api/graph is its live SQLite view, and
 * POST /mcp is stateless JSON-RPC 2.0. Auth is the portal's job; the server
 * itself binds loopback by default.
 *
 * The store and projection are opened per request: the server never holds
 * the SQLite or LadybugDB locks between requests, so extract/resolve/
 * project-build keep working in the same orb while it runs.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { profileFromLock, type ProfileLock } from "../profile/define.ts";
import { queryProjection } from "../project/ladybug.ts";
import { Store } from "../store/store.ts";
import { computeSurvey, renderSurvey } from "../survey/survey.ts";
import type { VisualizationConfig } from "../cli/config.ts";

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const DEFAULT_PROTOCOL = "2025-06-18";
const MAX_BODY = 1024 * 1024;

export interface ServeConfig {
  dbPath: string;
  projectionPath: string;
  lockPath: string;
  visualization?: VisualizationConfig;
}

export interface VisualizationGraph {
  initialized: boolean;
  revision: number;
  config: VisualizationConfig;
  stats: { facts: number; nodes: number; edges: number; claims: number };
  nodes: Array<{
    id: string;
    kind: string;
    label: string;
    identity: Record<string, string | number | boolean>;
    props: Record<string, unknown>;
    provenance: string;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    kind: string;
    identity: Record<string, string | number | boolean>;
    props: Record<string, unknown>;
    confidence: number;
    evidenceCount: number;
  }>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: number | string | null } & (
  | { result: unknown }
  | { error: { code: number; message: string } }
);

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf8"));
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
}

/** ---------- tools ---------- */

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(cfg: ServeConfig, args: Record<string, unknown>): Promise<string>;
}

function openStore(cfg: ServeConfig): Store {
  const lock = JSON.parse(readFileSync(cfg.lockPath, "utf8")) as ProfileLock;
  const store = new Store(cfg.dbPath);
  store.activateProfile(profileFromLock(lock), lock.hash);
  return store;
}

export function readVisualizationGraph(cfg: ServeConfig): VisualizationGraph {
  const config = cfg.visualization ?? {};
  const empty: VisualizationGraph = {
    initialized: false,
    revision: 0,
    config,
    stats: { facts: 0, nodes: 0, edges: 0, claims: 0 },
    nodes: [],
    edges: [],
  };
  if (!existsSync(cfg.lockPath)) return empty;

  const store = openStore(cfg);
  try {
    const count = (table: string, extra = ""): number =>
      (
        store.db
          .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE retired_rev IS NULL${extra}`)
          .get() as { c: number }
      ).c;
    const evidence = new Map(
      (
        store.db
          .prepare(
            `SELECT entity_stable, MAX(confidence) AS confidence, COUNT(*) AS evidence_count
             FROM evidence WHERE retired_rev IS NULL GROUP BY entity_stable`,
          )
          .all() as { entity_stable: string; confidence: number; evidence_count: number }[]
      ).map((row) => [row.entity_stable, row]),
    );
    const nodes = store.liveNodes().map((node) => {
      const labelField = config.nodes?.[node.kind]?.label;
      const configuredLabel = labelField ? (node.identity[labelField] ?? node.props[labelField]) : undefined;
      const identityLabel = Object.values(node.identity).map(String).join(" · ");
      return {
        id: node.stableId,
        kind: node.kind,
        label: configuredLabel === undefined ? identityLabel || node.stableId.slice(0, 10) : String(configuredLabel),
        identity: node.identity,
        props: node.props,
        provenance: node.provenance,
      };
    });
    const edges = store.liveEdges().map((edge) => {
      const ev = evidence.get(edge.stableId);
      return {
        id: edge.stableId,
        source: edge.fromStable,
        target: edge.toStable,
        kind: edge.kind,
        identity: edge.identity,
        props: edge.props,
        confidence: Number(ev?.confidence ?? 0),
        evidenceCount: Number(ev?.evidence_count ?? 0),
      };
    });
    return {
      initialized: true,
      revision: store.currentRevision(),
      config,
      stats: {
        facts: count("facts"),
        nodes: nodes.length,
        edges: edges.length,
        claims: count("claims", " AND status = 'open'"),
      },
      nodes,
      edges,
    };
  } finally {
    store.close();
  }
}

export const TOOLS: ToolDef[] = [
  {
    name: "graph_query",
    description:
      "Run a Cypher query against the project's knowledge-graph projection. " +
      "Node tables = node kinds (identity + scalar props as columns, propsJson, provenance); " +
      "rel tables = edge kinds with confidence and evidenceCount. " +
      "Kind names with dashes become underscores. Returns rows as JSON.",
    inputSchema: {
      type: "object",
      properties: { cypher: { type: "string", description: "The Cypher query to run." } },
      required: ["cypher"],
    },
    async run(cfg, args) {
      const cypher = args.cypher;
      if (typeof cypher !== "string" || cypher.trim() === "") throw new Error("graph_query requires a cypher string");
      const rows = await queryProjection(cfg.projectionPath, cypher);
      return JSON.stringify(rows, null, 2);
    },
  },
  {
    name: "survey",
    description:
      "The resolved/unresolved population of the knowledge graph: live fact/node/edge counts by kind, " +
      "stub nodes (referenced but never declared), and open claims. The to-do list for graph work.",
    inputSchema: { type: "object", properties: {} },
    async run(cfg) {
      const store = openStore(cfg);
      try {
        return renderSurvey(computeSurvey(store));
      } finally {
        store.close();
      }
    },
  },
  {
    name: "doctor",
    description:
      "Mechanical graph-health checks: near-duplicate identities, orphan edges, stale evidence, " +
      "double transcription, vocabulary drift, identity hygiene, dangling aliases. " +
      "Errors mean the graph lies; warnings mean it is noisy.",
    inputSchema: { type: "object", properties: {} },
    async run(cfg) {
      const { runDoctor, renderDoctor } = await import("../check/doctor.ts");
      const store = openStore(cfg);
      try {
        return renderDoctor(runDoctor(store));
      } finally {
        store.close();
      }
    },
  },
  {
    name: "status",
    description: "Store revision and live row counts (facts, nodes, edges, evidence, aliases, claims) as JSON.",
    inputSchema: { type: "object", properties: {} },
    async run(cfg) {
      const store = openStore(cfg);
      try {
        const count = (table: string): number =>
          (store.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE retired_rev IS NULL`).get() as { c: number }).c;
        return JSON.stringify(
          {
            revision: store.currentRevision(),
            facts: count("facts"),
            nodes: count("nodes"),
            edges: count("edges"),
            evidence: count("evidence"),
            aliases: count("aliases"),
            claims: count("claims"),
          },
          null,
          2,
        );
      } finally {
        store.close();
      }
    },
  },
];

/** ---------- JSON-RPC dispatch ---------- */

async function handleMessage(cfg: ServeConfig, msg: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  const reply = (result: unknown): JsonRpcResponse | null => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcResponse | null =>
    isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } };

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return fail(-32600, "invalid JSON-RPC 2.0 message");
  }
  switch (msg.method) {
    case "initialize": {
      const requested = (msg.params as { protocolVersion?: string } | undefined)?.protocolVersion;
      return reply({
        protocolVersion: requested && PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "trestle", version: version() },
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const params = (msg.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) return fail(-32602, `unknown tool "${params.name}"`);
      try {
        const text = await tool.run(cfg, params.arguments ?? {});
        return reply({ content: [{ type: "text", text }], isError: false });
      } catch (err) {
        // Tool-level failures are in-band results per the MCP spec.
        const text = err instanceof Error ? err.message : String(err);
        return reply({ content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `method not found: ${msg.method}`);
  }
}

/** ---------- HTTP ---------- */

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function sendFile(res: ServerResponse, path: string, contentType: string, cacheControl = "no-cache"): void {
  const body = readFileSync(path);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": cacheControl,
  });
  res.end(body);
}

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const VIZ_DIR = join(PACKAGE_ROOT, "src", "viz");

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
};

function serveVisualizationAsset(res: ServerResponse, pathname: string): boolean {
  if (pathname !== "/" && !pathname.startsWith("/assets/")) return false;
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const root = resolve(VIZ_DIR);
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${root}${sep}`) || !existsSync(path) || !statSync(path).isFile()) return false;
  const cacheControl = pathname === "/" ? "no-cache" : "public, max-age=31536000, immutable";
  sendFile(res, path, CONTENT_TYPES[extname(path)] ?? "application/octet-stream", cacheControl);
  return true;
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export function startServer(cfg: ServeConfig, opts: { port: number; host?: string }): Promise<RunningServer> {
  const host = opts.host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? "/", "http://trestle.local").pathname;
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && pathname === "/api/graph") {
        sendJson(res, 200, readVisualizationGraph(cfg));
        return;
      }
      if (req.method === "POST" && pathname === "/api/query") {
        const body = JSON.parse(await readBody(req)) as { query?: unknown };
        if (typeof body.query !== "string" || body.query.trim() === "") {
          sendJson(res, 400, { error: "query must be a non-empty string" });
          return;
        }
        sendJson(res, 200, await queryProjection(cfg.projectionPath, body.query));
        return;
      }
      if (req.method === "GET" && serveVisualizationAsset(res, pathname)) return;
      if (req.method !== "POST" || pathname !== "/mcp") {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch (err) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: err instanceof Error ? err.message : "parse error" },
        });
        return;
      }
      const messages = Array.isArray(parsed) ? (parsed as JsonRpcMessage[]) : [parsed as JsonRpcMessage];
      const responses: JsonRpcResponse[] = [];
      for (const msg of messages) {
        const r = await handleMessage(cfg, msg);
        if (r) responses.push(r);
      }
      if (responses.length === 0) {
        res.writeHead(202).end(); // notifications only
      } else {
        sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
      }
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : opts.port;
      resolve({
        server,
        port,
        close: () => new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done()))),
      });
    });
  });
}
