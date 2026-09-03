/**
 * The resolver kit: named-rule runner (used by every primitive) and
 * P0 fact mapping. P1 binding joins are `slice.index` + plain loops
 * (see the dd-resolution template). Later primitives (P2 name
 * transforms, P3 constant propagation, P4 fixpoint, P5 lifting,
 * P6 corroboration) land as they are needed by real profiles.
 */
import type { FactRow } from "../store/store.ts";
import type { NodeRef } from "./directives.ts";
import type { Emitter, Slice } from "./api.ts";
import type { Scalar } from "../profile/validate.ts";

/** ---------- named rules ---------- */

export type Rule<T, R extends object> = R & { name: string; when(x: T): boolean };

export interface RuleSet<T, R extends object> {
  apply(x: T): (Rule<T, R> & { setName: string }) | undefined;
  require(x: T): Rule<T, R> & { setName: string };
}

export function rules<T, R extends object>(setName: string, list: Rule<T, R>[]): RuleSet<T, R> {
  return {
    apply(x) {
      const rule = list.find((r) => r.when(x));
      return rule ? { ...rule, setName } : undefined;
    },
    require(x) {
      const rule = this.apply(x);
      if (!rule) throw new Error(`rules "${setName}": no rule matched`);
      return rule;
    },
  };
}

/** ---------- P0: fact mapping ---------- */

export interface NodeMapRule {
  when?(f: FactRow): boolean;
  node(f: FactRow): { kind: string; identity: Record<string, Scalar>; props?: Record<string, unknown> } | null;
  rule: string;
}

export interface EdgeMapRule {
  when?(f: FactRow): boolean;
  edge: string;
  from(f: FactRow): NodeRef | null;
  to(f: FactRow): NodeRef | null;
  identity?(f: FactRow): Record<string, Scalar>;
  props?(f: FactRow): Record<string, unknown>;
  rule: string;
}

export type MapRule = NodeMapRule | EdgeMapRule;

/**
 * The degenerate-but-dominant case: the fact already contains the
 * conclusion; turning it into a graph entity is a mechanical rewrite.
 * Evidence attaches automatically from the fact.
 */
export function mapFacts(slice: Slice, emit: Emitter, table: Record<string, MapRule[]>): void {
  for (const [kind, ruleList] of Object.entries(table)) {
    for (const f of slice.facts(kind)) {
      for (const rule of ruleList) {
        if (rule.when && !rule.when(f)) continue;
        if ("node" in rule) {
          const n = rule.node(f);
          if (n) emit.node(n.kind, n.identity, n.props, { evidence: [f], rule: rule.rule });
        } else {
          const from = rule.from(f);
          const to = rule.to(f);
          if (from === null || to === null) continue;
          emit.edge(
            rule.edge,
            { from, to, identity: rule.identity?.(f) },
            { evidence: [f], rule: rule.rule, props: rule.props?.(f) },
          );
        }
      }
    }
  }
}
