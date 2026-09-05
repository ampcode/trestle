import { createHash } from "node:crypto";
import { isString, isNumber, isBoolean, type JsonValue, type Properties } from "./value.ts";

/** Deterministic JSON: recursively sorted object keys, undefined dropped. */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && v !== undefined && !isString(v) && !isNumber(v) && !isBoolean(v)) {
    const out: Properties = {};
    for (const k of Object.keys(v).sort()) {
      const val = v[k];
      if (val !== undefined) out[k] = sortValue(val);
    }
    return out;
  }
  return v;
}

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Content-derived logical key: hash of the canonical serialization, truncated. */
export function stableHash(value: JsonValue): string {
  return sha256(canonicalJson(value)).slice(0, 24);
}
