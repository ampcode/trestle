import { isBuilder, isPropSchema, type PropSchema, type TypeBuilder } from "./schema.ts";
import { canonicalJson, sha256 } from "./canonical.ts";
import { isFunction, isNumber, isProperties, isString, type JsonValue } from "./value.ts";

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

export type NodeKindDef = {
  identity: string[];
  props: Record<string, PropSchema>;
};
export type EdgeKindDef = {
  from: string[];
  to: string[];
  identity: string[];
  props: Record<string, PropSchema>;
};
export type FactKindDef = {
  version: number;
  props: Record<string, PropSchema>;
};
export type Profile = {
  __trestleProfile: true;
  nodes: Record<string, NodeKindDef>;
  edges: Record<string, EdgeKindDef>;
  facts: Record<string, FactKindDef>;
};

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
    if (!isNumber(def.version)) errors.push(`fact kind "${kind}": version must be a number`);
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
) {
  const out: Record<string, PropSchema> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (isBuilder(value)) {
      out[name] = value.__trestleSchema;
    } else if (isFunction(value)) {
      errors.push(`${where}: prop "${name}" is a function — profiles must be inert data`);
    } else {
      errors.push(`${where}: prop "${name}" is not a t.* schema`);
    }
  }
  return out;
}

/** ---------- lock file ---------- */

export type ProfileLock = {
  trestleLockVersion: 1;
  hash: string;
  profile: Omit<Profile, "__trestleProfile">;
};

function isStringList(value: JsonValue): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isSchemaMap(value: JsonValue): value is Record<string, PropSchema> {
  return isProperties(value) && Object.values(value).every(isPropSchema);
}

/** Structural validation, not a recompile or a check of the lock's content hash. */
function isProfileData(value: JsonValue): value is ProfileLock["profile"] {
  if (!isProperties(value) || !isProperties(value.nodes) || !isProperties(value.edges) || !isProperties(value.facts)) {
    return false;
  }
  return Object.values(value.nodes).every((node) =>
    isProperties(node) && isStringList(node.identity) && isSchemaMap(node.props),
  ) && Object.values(value.edges).every((edge) =>
    isProperties(edge) && isStringList(edge.from) && isStringList(edge.to) &&
    isStringList(edge.identity) && isSchemaMap(edge.props),
  ) && Object.values(value.facts).every((fact) =>
    isProperties(fact) && isNumber(fact.version) && isSchemaMap(fact.props),
  );
}

export function isProfile(value: unknown): value is Profile {
  return isProperties(value) && value.__trestleProfile === true && isProfileData(value);
}

export function isProfileLock(value: unknown): value is ProfileLock {
  return isProperties(value) && value.trestleLockVersion === 1 && isString(value.hash) &&
    isProfileData(value.profile);
}

export function buildLock(profile: Profile): ProfileLock {
  const { __trestleProfile: _mark, ...bare } = profile;
  return {
    trestleLockVersion: 1,
    hash: sha256(canonicalJson(bare)),
    // SAFETY: this parses our own canonical serialization of the compiled profile,
    // not external input; the round-trip retains its node/edge/fact structure.
    profile: JSON.parse(canonicalJson(bare)) as ProfileLock["profile"],
  };
}

export function profileFromLock(lock: ProfileLock): Profile {
  return { __trestleProfile: true, ...lock.profile };
}
