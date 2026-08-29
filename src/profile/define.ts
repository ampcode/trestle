import { isBuilder, type PropSchema, type TypeBuilder } from "./schema.ts";
import { canonicalJson, sha256 } from "./canonical.ts";

/** ---------- authored spec (what the user writes) ---------- */

export interface NodeKindSpec {
  /** Identity tuple: scalar fields, all required, immutable. Not props. */
  identity: string[];
  props?: Record<string, TypeBuilder>;
}

export interface EdgeKindSpec {
  from: string[];
  to: string[];
  props?: Record<string, TypeBuilder>;
  /** Optional identity tuple of prop names; differing values = distinct edges. */
  identity?: string[];
}

export interface FactKindSpec {
  version: number;
  props?: Record<string, TypeBuilder>;
}

export interface ProfileSpec {
  nodes: Record<string, NodeKindSpec>;
  edges: Record<string, EdgeKindSpec>;
  facts: Record<string, FactKindSpec>;
}

/** ---------- compiled profile (inert data; what the engine ingests) ---------- */

export interface NodeKindDef {
  identity: string[];
  props: Record<string, PropSchema>;
}
export interface EdgeKindDef {
  from: string[];
  to: string[];
  identity: string[];
  props: Record<string, PropSchema>;
}
export interface FactKindDef {
  version: number;
  props: Record<string, PropSchema>;
}
export interface Profile {
  __trestleProfile: true;
  nodes: Record<string, NodeKindDef>;
  edges: Record<string, EdgeKindDef>;
  facts: Record<string, FactKindDef>;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Evaluate an authored spec into the canonical profile. Rejects functions
 * anywhere in the tree — vocabulary must be inert, serializable data.
 */
export function defineProfile(spec: ProfileSpec): Profile {
  const errors: string[] = [];
  const nodes: Record<string, NodeKindDef> = {};
  const edges: Record<string, EdgeKindDef> = {};
  const facts: Record<string, FactKindDef> = {};

  for (const [kind, def] of Object.entries(spec.nodes ?? {})) {
    if (!NAME_RE.test(kind)) errors.push(`node kind "${kind}": invalid name`);
    if (!Array.isArray(def.identity) || def.identity.length === 0) {
      errors.push(`node kind "${kind}": identity must be a non-empty string array`);
      continue;
    }
    nodes[kind] = { identity: [...def.identity], props: compileProps(def.props, `node ${kind}`, errors) };
  }

  for (const [kind, def] of Object.entries(spec.edges ?? {})) {
    if (!NAME_RE.test(kind)) errors.push(`edge kind "${kind}": invalid name`);
    for (const end of [...(def.from ?? []), ...(def.to ?? [])]) {
      if (!nodes[end]) errors.push(`edge kind "${kind}": endpoint kind "${end}" is not a declared node kind`);
    }
    const props = compileProps(def.props, `edge ${kind}`, errors);
    const identity = [...(def.identity ?? [])];
    for (const field of identity) {
      const schema = props[field];
      if (!schema) errors.push(`edge kind "${kind}": identity prop "${field}" is not declared in props`);
      else if (schema.optional) errors.push(`edge kind "${kind}": identity prop "${field}" must be required`);
      else if (schema.t === "array" || schema.t === "json" || schema.t === "boolean")
        errors.push(`edge kind "${kind}": identity prop "${field}" must be a scalar (string/number/enum)`);
    }
    edges[kind] = { from: [...(def.from ?? [])], to: [...(def.to ?? [])], identity, props };
  }

  for (const [kind, def] of Object.entries(spec.facts ?? {})) {
    if (typeof def.version !== "number") errors.push(`fact kind "${kind}": version must be a number`);
    facts[kind] = { version: def.version, props: compileProps(def.props, `fact ${kind}`, errors) };
  }

  if (errors.length > 0) {
    throw new Error(`defineProfile: invalid profile\n  - ${errors.join("\n  - ")}`);
  }
  return { __trestleProfile: true, nodes, edges, facts };
}

function compileProps(
  props: Record<string, TypeBuilder> | undefined,
  where: string,
  errors: string[],
): Record<string, PropSchema> {
  const out: Record<string, PropSchema> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (isBuilder(value)) {
      out[name] = value.__trestleSchema;
    } else if (typeof value === "function") {
      errors.push(`${where}: prop "${name}" is a function — profiles must be inert data`);
    } else {
      errors.push(`${where}: prop "${name}" is not a t.* schema`);
    }
  }
  return out;
}

/** ---------- lock file ---------- */

export interface ProfileLock {
  trestleLockVersion: 1;
  hash: string;
  profile: Omit<Profile, "__trestleProfile">;
}

export function buildLock(profile: Profile): ProfileLock {
  const { __trestleProfile: _mark, ...bare } = profile;
  return {
    trestleLockVersion: 1,
    hash: sha256(canonicalJson(bare)),
    profile: JSON.parse(canonicalJson(bare)) as ProfileLock["profile"],
  };
}

export function profileFromLock(lock: ProfileLock): Profile {
  return { __trestleProfile: true, ...lock.profile };
}
