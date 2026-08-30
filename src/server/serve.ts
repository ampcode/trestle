/**
 * `trestle serve`: the project's query endpoint (ARCHITECTURE §5/§7).
 *
 * A minimal MCP server over Streamable HTTP, meant to run as a supervised
 * service inside the project orb and be exposed through the orb portal.
 * Any Amp thread can then attach it as a remote MCP server (or POST
 * JSON-RPC directly) to query the knowledge graph without entering the orb.
 *
 * Protocol: stateless JSON-RPC 2.0 over POST (single messages or batches),
 * JSON responses only — no SSE streams, no sessions. Auth is the portal's
 * job; the server itself binds loopback by default.
 *
 * The store and projection are opened per request: the server never holds
 * the SQLite or LadybugDB locks between requests, so extract/resolve/
 * project-build keep working in the same orb while it runs.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { profileFromLock, type ProfileLock } from "../profile/define.ts";
import { queryProjection } from "../project/ladybug.ts";
import { Store } from "../store/store.ts";
import { computeSurvey, renderSurvey } from "../survey/survey.ts";

const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const DEFAULT_PROTOCOL = "2025-06-18";
const MAX_BODY = 1024 * 1024;

export interface ServeConfig {
  dbPath: string;
  projectionPath: string;
  lockPath: string;
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

const TOOLS: ToolDef[] = [
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
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
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
      if (req.method === "GET" && req.url === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "POST JSON-RPC messages to this endpoint" });
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
