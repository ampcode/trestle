import type { PropSchema } from "./schema.ts";

/**
 * Write-boundary prop validation. Returns error strings (empty = valid).
 * Strict on both sides: required fields must be present, undeclared
 * fields are rejected (that is how typos surface).
 */
export function validateProps(
  schemas: Record<string, PropSchema>,
  props: Record<string, unknown>,
  where: string,
): string[] {
  const errors: string[] = [];
  for (const [name, schema] of Object.entries(schemas)) {
    const value = props[name];
    if (value === undefined || value === null) {
      if (!schema.optional) errors.push(`${where}: missing required prop "${name}"`);
      continue;
    }
    const err = validateValue(schema, value);
    if (err) errors.push(`${where}: prop "${name}" ${err}`);
  }
  for (const name of Object.keys(props)) {
    if (props[name] === undefined) continue;
    if (!(name in schemas)) errors.push(`${where}: undeclared prop "${name}"`);
  }
  return errors;
}

function validateValue(schema: PropSchema, value: unknown): string | null {
  switch (schema.t) {
    case "string":
      return typeof value === "string" ? null : `must be a string, got ${typeof value}`;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : `must be a finite number`;
    case "boolean":
      return typeof value === "boolean" ? null : `must be a boolean`;
    case "enum":
      return typeof value === "string" && schema.values.includes(value)
        ? null
        : `must be one of [${schema.values.join(", ")}], got ${JSON.stringify(value)}`;
    case "array": {
      if (!Array.isArray(value)) return `must be an array`;
      for (let i = 0; i < value.length; i++) {
        const err = validateValue(schema.items, value[i]);
        if (err) return `[${i}] ${err}`;
      }
      return null;
    }
    case "json":
      try {
        JSON.stringify(value);
        return null;
      } catch {
        return `must be JSON-serializable`;
      }
  }
}

export type Scalar = string | number | boolean;

export function isScalar(v: unknown): v is Scalar {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Identity tuples: scalar fields, all required. */
export function validateIdentity(
  fields: string[],
  identity: Record<string, unknown>,
  where: string,
): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    const v = identity[field];
    if (v === undefined || v === null) errors.push(`${where}: missing identity field "${field}"`);
    else if (!isScalar(v)) errors.push(`${where}: identity field "${field}" must be a scalar`);
  }
  for (const field of Object.keys(identity)) {
    if (!fields.includes(field)) errors.push(`${where}: unknown identity field "${field}"`);
  }
  return errors;
}
