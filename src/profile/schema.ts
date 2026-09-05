/**
 * The `t.*` prop-schema builders. One declaration yields three things:
 * a TypeScript type (via the phantom parameter), a runtime validator
 * (src/profile/validate.ts), and index DDL (store, on profile activation).
 *
 * Builders are inert data plus one method (`optional()`); defineProfile
 * strips them to plain `PropSchema` objects before hashing, so the
 * "no functions in the profile tree" rule applies to user values only.
 */
import { isBoolean, isProperties, isString, type JsonValue } from "./value.ts";

export type PropSchema =
  | { t: "string"; optional?: boolean; indexed?: boolean }
  | { t: "number"; optional?: boolean; indexed?: boolean }
  | { t: "boolean"; optional?: boolean }
  | { t: "enum"; values: string[]; optional?: boolean; indexed?: boolean }
  | { t: "array"; items: PropSchema; optional?: boolean }
  | { t: "json"; optional?: boolean };

/** Validate inert schema data after decoding its JSON value tree. */
export function isPropSchema(value: JsonValue): value is PropSchema {
  if (!isProperties(value)) return false;
  if (value.optional !== undefined && !isBoolean(value.optional)) return false;
  if (value.indexed !== undefined && !isBoolean(value.indexed)) return false;
  switch (value.t) {
    case "string":
    case "number":
    case "boolean":
    case "json":
      return true;
    case "enum":
      return Array.isArray(value.values) && value.values.every(isString);
    case "array":
      return isPropSchema(value.items);
    default:
      return false;
  }
}

export interface TypeBuilder<T = JsonValue> {
  readonly __trestleSchema: PropSchema;
  /** Marks the prop as omittable. */
  optional(): TypeBuilder<T | undefined>;
  /** Requests a partial expression index on this prop (store-side). */
  indexed(): TypeBuilder<T>;
}

function builder<T>(schema: PropSchema): TypeBuilder<T> {
  return {
    __trestleSchema: schema,
    optional() {
      return builder<T | undefined>({ ...schema, optional: true });
    },
    indexed() {
      if (schema.t === "boolean" || schema.t === "array" || schema.t === "json") {
        throw new Error(`t.${schema.t}() cannot be indexed`);
      }
      return builder<T>({ ...schema, indexed: true });
    },
  };
}

export const t = {
  string: () => builder<string>({ t: "string" }),
  number: () => builder<number>({ t: "number" }),
  boolean: () => builder<boolean>({ t: "boolean" }),
  enum: <const V extends readonly [string, ...string[]]>(...values: V) =>
    builder<V[number]>({ t: "enum", values: [...values] }),
  array: <T>(items: TypeBuilder<T>) => builder<T[]>({ t: "array", items: items.__trestleSchema }),
  /** Arbitrary JSON-serializable value; escape hatch, validated only for serializability. */
  json: () => builder<JsonValue>({ t: "json" }),
};

export function isBuilder(v: unknown): v is TypeBuilder {
  return typeof v === "object" && v !== null && "__trestleSchema" in v;
}
