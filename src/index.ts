/**
 * trestle — the root export that user files import by the package
 * self-reference (`import { resolver } from "trestle"`).
 *
 * Profile authoring:   defineProfile, t
 * Extraction pipeline: pipeline
 * Resolver API:        resolver, rules, mapFacts
 * Engine internals (used by the CLI and tests): Store, runExtraction, runResolvers, computeSurvey
 */

export { defineProfile, buildLock, profileFromLock } from "./profile/define.ts";
export type {
  Profile,
  ProfileSpec,
  ProfileLock,
  NodeKindSpec,
  EdgeKindSpec,
  FactKindSpec,
} from "./profile/define.ts";
export { t } from "./profile/schema.ts";
export type { TypeBuilder, PropSchema } from "./profile/schema.ts";
export { canonicalJson, stableHash, sha256 } from "./profile/canonical.ts";

export { pipeline } from "./extract/pipeline.ts";
export type { PipelineCtx, PipelineFn, Corpus } from "./extract/pipeline.ts";
export { runExtraction } from "./extract/run.ts";

export { resolver } from "./resolve/api.ts";
export type { ResolverDef, Slice, Emitter, FactIndex } from "./resolve/api.ts";
export { rules, mapFacts } from "./resolve/kit.ts";
export type { Rule, RuleSet, MapRule } from "./resolve/kit.ts";
export type { Directive, NodeRef, EvidenceInput } from "./resolve/directives.ts";
export { loadResolvers, runResolvers } from "./resolve/run.ts";

export { Store } from "./store/store.ts";
export type { FactRow, NodeRow, EdgeRow, FactInput } from "./store/store.ts";

export { buildProjection, queryProjection } from "./project/ladybug.ts";
export type { ProjectionResult } from "./project/ladybug.ts";

export { computeSurvey, renderSurvey } from "./survey/survey.ts";
export type { Survey } from "./survey/survey.ts";

export type {
  TrestleConfig,
  VisualizationConfig,
  VisualizationNodeStyle,
  VisualizationEdgeStyle,
} from "./cli/config.ts";
export { runCli } from "./cli/main.ts";
