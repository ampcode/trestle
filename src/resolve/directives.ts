import type { Scalar } from "../profile/validate.ts";
import type { JsonValue, Properties } from "../profile/value.ts";

/** "Kind:value" shorthand (single-field identity) or explicit object form. */
export type NodeRef = string | { kind: string; identity: Record<string, Scalar> };

export interface EvidenceInput {
  factId?: number;
  sourcePath?: string;
  locator?: JsonValue;
}

export type Directive =
  | {
      op: "node";
      kind: string;
      identity: Record<string, Scalar>;
      props?: Properties;
      evidence?: EvidenceInput[];
      rule?: string;
      note?: string;
    }
  | {
      op: "edge";
      kind: string;
      from: NodeRef;
      to: NodeRef;
      /** Values for the edge kind's declared identity props (merged into props). */
      identity?: Record<string, Scalar>;
      props?: Properties;
      evidence: EvidenceInput[];
      rule?: string;
      note?: string;
    }
  | { op: "alias"; canonical: NodeRef; alias: NodeRef }
  | {
      op: "claim";
      kind: string;
      about?: JsonValue[];
      detail: string;
      candidates?: string[];
      rule?: string;
    };
