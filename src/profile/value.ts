/** Values stored as JSON; undefined object properties are omitted on serialization. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

export type Properties = Record<string, JsonValue>;

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Numeric representation only; schemas apply finite-number constraints separately. */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

export function isFunction(value: unknown): value is (...args: never[]) => void {
  return typeof value === "function";
}

/** Validate the entire value tree, rejecting cycles but allowing shared subtrees. */
export function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || value === undefined || isString(value) || isNumber(value) || isBoolean(value)) {
    return true;
  }
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false;
  ancestors.add(value);
  try {
    return Object.values(value).every((child) => isJsonValue(child, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

export function isProperties(value: unknown): value is Properties {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonValue(value);
}
