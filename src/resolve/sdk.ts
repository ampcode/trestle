import type { FactRow, NodeRow, EdgeRow } from "../store/store.ts";
import type { Directive, EvidenceInput, NodeRef } from "./directives.ts";
import type { Scalar } from "../profile/validate.ts";
import { canonicalJson } from "../profile/canonical.ts";

/** ---------- slice: the resolver's read surface ---------- */

export class FactList extends Array<FactRow> {
  where(pred: (f: FactRow) => boolean): FactList {
    return FactList.from(this.filter(pred)) as FactList;
  }
}

export interface FactIndex {
  get(key: Scalar | Scalar[]): FactRow[];
  keys(): string[];
}

export interface Slice {
  /** Live facts of one consumed kind. */
  facts(kind: string): FactList;
  /** Build a join index: keyFn returns a key (or null to skip the fact). */
  index(kind: string, keyFn: (f: FactRow) => Scalar | Scalar[] | null): FactIndex;
  /** Read the graph produced by earlier phases. */
  nodes(kind?: string): NodeRow[];
  edges(kind?: string): EdgeRow[];
}

export function makeSlice(deps: {
  factsByKind(kind: string): FactRow[];
  liveNodes(kind?: string): NodeRow[];
  liveEdges(kind?: string): EdgeRow[];
  consumedFacts: string[] | undefined;
}): Slice {
  const cache = new Map<string, FactList>();
  const facts = (kind: string): FactList => {
    if (deps.consumedFacts && !deps.consumedFacts.includes(kind)) {
      throw new Error(`slice: fact kind "${kind}" is not declared in consumes.facts`);
    }
    let list = cache.get(kind);
    if (!list) {
      list = FactList.from(deps.factsByKind(kind)) as FactList;
      cache.set(kind, list);
    }
    return list;
  };
  return {
    facts,
    index(kind, keyFn) {
      const map = new Map<string, FactRow[]>();
      for (const f of facts(kind)) {
        const key = keyFn(f);
        if (key === null || key === undefined) continue;
        const k = canonicalJson(Array.isArray(key) ? key : [key]);
        const bucket = map.get(k);
        if (bucket) bucket.push(f);
        else map.set(k, [f]);
      }
      return {
        get(key) {
          return map.get(canonicalJson(Array.isArray(key) ? key : [key])) ?? [];
        },
        keys() {
          return [...map.keys()];
        },
      };
    },
    nodes: (kind) => deps.liveNodes(kind),
    edges: (kind) => deps.liveEdges(kind),
  };
}

/** ---------- emitter: the resolver's write surface ---------- */

export interface EdgeOpts {
  /** Facts (or explicit locators) backing this edge. Required: silence is not an option. */
  evidence: (FactRow | EvidenceInput)[];
  confidence?: number;
  rule?: string;
  note?: string;
  props?: Record<string, unknown>;
}

export interface Emitter {
  node(kind: string, identity: Record<string, Scalar>, props?: Record<string, unknown>, opts?: { rule?: string }): void;
  edge(kind: string, endpoints: { from: NodeRef; to: NodeRef; identity?: Record<string, Scalar> }, opts: EdgeOpts): void;
  alias(canonical: NodeRef, alias: NodeRef): void;
  claim(
    kind: string,
    opts: { about?: unknown[]; detail: string; candidates?: string[]; rule?: string },
  ): void;
  /** Explicitly skip an unmatched item, with a reason (recorded in run stats). */
  ignore(subject: unknown, reason: string): void;
}

export interface CollectedOutput {
  directives: Directive[];
  ignored: { subject: unknown; reason: string }[];
}

export function makeEmitter(): { emit: Emitter; output: CollectedOutput } {
  const output: CollectedOutput = { directives: [], ignored: [] };
  const toEvidence = (e: FactRow | EvidenceInput): EvidenceInput =>
    "id" in e && "props" in e
      ? { factId: e.id, sourcePath: e.sourcePath, locator: e.locator, confidence: e.confidence }
      : (e as EvidenceInput);
  const emit: Emitter = {
    node(kind, identity, props, opts) {
      output.directives.push({ op: "node", kind, identity, props, rule: opts?.rule });
    },
    edge(kind, endpoints, opts) {
      if (!opts?.evidence || opts.evidence.length === 0) {
        throw new Error(`emit.edge(${kind}): evidence is required on every edge`);
      }
      output.directives.push({
        op: "edge",
        kind,
        from: endpoints.from,
        to: endpoints.to,
        identity: endpoints.identity,
        props: opts.props,
        evidence: opts.evidence.map(toEvidence),
        confidence: opts.confidence,
        rule: opts.rule,
        note: opts.note,
      });
    },
    alias(canonical, alias) {
      output.directives.push({ op: "alias", canonical, alias });
    },
    claim(kind, opts) {
      output.directives.push({
        op: "claim",
        kind,
        about: opts.about,
        detail: opts.detail,
        candidates: opts.candidates,
        rule: opts.rule,
      });
    },
    ignore(subject, reason) {
      output.ignored.push({ subject, reason });
    },
  };
  return { emit, output };
}

/** ---------- resolver definition ---------- */

export interface ResolverDef {
  name: string;
  phase: number;
  version?: string;
  consumes?: { facts?: string[] };
  run(slice: Slice, emit: Emitter): void | Promise<void>;
}

export interface ResolverModule extends ResolverDef {
  __trestleResolver: true;
}

export function resolver(def: ResolverDef): ResolverModule {
  if (!def.name) throw new Error("resolver: name is required");
  if (typeof def.phase !== "number") throw new Error(`resolver "${def.name}": phase is required`);
  if (typeof def.run !== "function") throw new Error(`resolver "${def.name}": run() is required`);
  return { __trestleResolver: true, ...def };
}

export function isResolverModule(v: unknown): v is ResolverModule {
  return typeof v === "object" && v !== null && (v as Record<string, unknown>).__trestleResolver === true;
}
