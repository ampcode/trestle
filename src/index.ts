/**
 * trestle — the root export that user files import by the package
 * self-reference (`import { resolver } from "trestle"`).
 *
 * Profile:  defineProfile, t
 * Pipeline: pipeline
 * Resolver: resolver, rules, mapFacts
 * Config:   TrestleConfig
 *
 * Engine internals (Store, runExtraction, runResolvers, …) are not
 * re-exported here; the CLI and tests import them by path.
 */

export { defineProfile } from "./profile/define.ts";
export type { Profile, ProfileSpec, NodeKindSpec, EdgeKindSpec, FactKindSpec } from "./profile/define.ts";
export { t } from "./profile/schema.ts";
export type { TypeBuilder, PropSchema } from "./profile/schema.ts";

export { pipeline } from "./extract/pipeline.ts";
export type { PipelineCtx, PipelineFn, Corpus } from "./extract/pipeline.ts";

export { resolver } from "./resolve/api.ts";
export type { ResolverDef, Slice, Emitter, FactIndex } from "./resolve/api.ts";
export { rules, mapFacts } from "./resolve/kit.ts";
export type { Rule, RuleSet, MapRule } from "./resolve/kit.ts";
export type { Directive, NodeRef, EvidenceInput } from "./resolve/directives.ts";
export type { FactRow, NodeRow, EdgeRow } from "./store/store.ts";

export type {
  TrestleConfig,
  VisualizationConfig,
  VisualizationNodeStyle,
  VisualizationEdgeStyle,
} from "./cli/config.ts";
