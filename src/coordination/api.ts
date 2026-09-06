import { isProperties, isString, isNumber, type JsonValue, type Properties } from "../profile/value.ts";
import type { Coordination } from "./core.ts";
import type { ArtifactInput, SessionRef } from "./types.ts";

const states = ["idle", "working", "awaiting-input", "closed", "unknown"] as const;
const statuses = ["planned", "active", "blocked", "complete"] as const;
const kinds = ["decision", "verification", "blocker", "handoff"] as const;
export const operations = [
  "registerSession", "observeSession", "getSession", "listSessions", "getSessionHistory",
  "createUnit", "getUnit", "listUnits", "setUnitStatus", "attachSession", "handoffLead", "getUnitHistory",
  "indexArtifacts", "searchArtifacts", "getArtifact", "createBookmark", "getBookmark", "listBookmarks",
] as const;

export const coordinationSchema = {
  type: "object",
  properties: {
    operation: { type: "string", enum: [...operations] },
    arguments: { type: "object", description: "Operation arguments; session references are {provider,sessionId}. See coordination API documentation." },
    requestId: { type: "string", description: "Required stable idempotency key for mutations; reuse on retry, never for different arguments." },
  }, required: ["operation", "arguments"], additionalProperties: false,
};

function object(value: JsonValue): Properties {
  if (!isProperties(value)) throw new Error("expected a JSON object");
  return value;
}
function text(value: JsonValue): string {
  if (!isString(value) || !value.trim()) throw new Error("expected a non-empty string");
  return value;
}
function optionalText(value: JsonValue): string | undefined { return value === undefined ? undefined : text(value); }
function integer(value: JsonValue): number {
  if (!isNumber(value) || !Number.isSafeInteger(value) || value < 0) throw new Error("expected a non-negative integer");
  return value;
}
function choice<T extends string>(value: JsonValue, values: readonly T[]): T {
  const found = values.find(option => option === value);
  if (!found) throw new Error(`expected one of: ${values.join(", ")}`);
  return found;
}
function ref(value: JsonValue): SessionRef {
  const input = object(value);
  return { provider: text(input.provider), sessionId: text(input.sessionId) };
}
function artifact(value: JsonValue): ArtifactInput {
  const input = object(value);
  if (input.locator === undefined) throw new Error("artifact locator is required");
  return { session: ref(input.session), nativeId: text(input.nativeId), kind: text(input.kind),
    locator: input.locator, metadata: object(input.metadata ?? {}),
    text: input.text === undefined ? undefined : (isString(input.text) ? input.text : text(input.text)) };
}

/** Transport boundary: narrows JSON and never accepts an actor identity from request data. */
export function callCoordination(core: Coordination, request: JsonValue): JsonValue {
  const envelope = object(request);
  if (envelope.actor !== undefined) throw new Error("actor identity is supplied by the transport");
  const operation = choice(envelope.operation, operations);
  const args = object(envelope.arguments);
  if (args.actor !== undefined) throw new Error("actor identity is supplied by the transport");
  const key = (): string => text(envelope.requestId);
  const offset = (): number => integer(args.offset ?? 0);
  switch (operation) {
    case "registerSession": return core.registerSession({ ref: ref(args.ref), url: optionalText(args.url), title: optionalText(args.title) }, key());
    case "observeSession": return core.observeSession({ session: ref(args.session), state: choice(args.state, states),
      observedAt: text(args.observedAt), nativeState: optionalText(args.nativeState) }, key());
    case "getSession": return core.getSession(ref(args.ref));
    case "getSessionHistory": return core.getSessionHistory(ref(args.ref), offset());
    case "listSessions": return core.listSessions({ provider: optionalText(args.provider), unitId: optionalText(args.unitId),
      state: args.state === undefined ? undefined : choice(args.state, states), offset: offset() });
    case "createUnit": {
      const scope = object(args.scope);
      if (!Array.isArray(scope.entityIds)) throw new Error("scope.entityIds must be an array");
      return core.createUnit({ id: text(args.id), title: text(args.title), objective: text(args.objective), acceptance: text(args.acceptance),
        lead: ref(args.lead), scope: { graphRevision: integer(scope.graphRevision), entityIds: scope.entityIds.map(text), sourceRevision: text(scope.sourceRevision) } }, key());
    }
    case "getUnit": return core.getUnit(text(args.id));
    case "listUnits": return core.listUnits({ status: args.status === undefined ? undefined : choice(args.status, statuses), offset: offset() });
    case "setUnitStatus": return core.setUnitStatus(text(args.id), integer(args.expectedRevision), choice(args.status, statuses), text(args.reason), key());
    case "attachSession": return core.attachSession(text(args.unitId), ref(args.ref), key());
    case "handoffLead": return core.handoffLead(text(args.id), integer(args.expectedRevision), ref(args.newLead), text(args.bookmarkId), key());
    case "getUnitHistory": return core.getUnitHistory(text(args.id), offset());
    case "indexArtifacts": {
      if (!Array.isArray(args.artifacts)) throw new Error("artifacts must be an array");
      return core.indexArtifacts(args.artifacts.map(artifact), key());
    }
    case "searchArtifacts": return core.searchArtifacts({ provider: optionalText(args.provider), session: args.session === undefined ? undefined : ref(args.session),
      kind: optionalText(args.kind), query: optionalText(args.query), offset: offset() });
    case "getArtifact": return core.getArtifact(text(args.id));
    case "createBookmark": return core.createBookmark(text(args.unitId), text(args.artifactId), choice(args.kind, kinds), text(args.description), key());
    case "getBookmark": return core.getBookmark(text(args.id));
    case "listBookmarks": return core.listBookmarks(text(args.unitId), { kind: args.kind === undefined ? undefined : choice(args.kind, kinds), offset: offset() });
  }
}
