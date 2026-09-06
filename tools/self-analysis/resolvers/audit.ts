import { resolver } from "../../../src/index.ts";

export default resolver({
  name: "self-audit", phase: 10,
  consumes: { facts: ["file-parsed", "function-declared", "reference-observed"] },
  run(slice, emit) {
    for (const file of slice.facts("file-parsed")) {
      emit.node("File", { path: String(file.props.path) }, {}, { evidence: [file], rule: "parsed-file" });
    }
    const functions = slice.facts("function-declared");
    const references = slice.index("reference-observed", fact => String(fact.props.target));
    const bodies = slice.index("function-declared", fact => String(fact.props.bodyHash));
    const normalizedBodies = slice.index("function-declared", fact => String(fact.props.normalizedBodyHash));
    for (const fn of functions) {
      const key = String(fn.props.key);
      const { name, path, category, exported, tokens } = fn.props;
      emit.node("Function", { key }, { name, path, category, exported, tokens }, { evidence: [fn], rule: "named-declaration" });
      const uses = references.get(key);
      for (const sourcePath of new Set(uses.map(use => use.sourcePath))) {
        emit.edge("REFERENCES", { from: `File:${sourcePath}`, to: `Function:${key}` },
          { evidence: [...uses.filter(use => use.sourcePath === sourcePath), fn], rule: "compiler-symbol-reference" });
      }
      if (!uses.length && fn.sourcePath.startsWith("src/")) {
        emit.claim("no-observed-reference", { about: [key], rule: "reference-absence-candidate",
          detail: `${key}: no compiler-resolved identifier references in the selected corpus. ${category}; exported=${exported}. Check public/dynamic entry points before removal.` });
      }
      if (Number(tokens) < 30) continue;
      for (const other of bodies.get(String(fn.props.bodyHash))) {
        if (key >= String(other.props.key)) continue;
        emit.edge("SAME_BODY", { from: `Function:${key}`, to: `Function:${other.props.key}` },
          { evidence: [fn, other], rule: "identical-body-tokens-at-least-30" });
      }
      for (const other of normalizedBodies.get(String(fn.props.normalizedBodyHash))) {
        if (key >= String(other.props.key) || fn.props.bodyHash === other.props.bodyHash) continue;
        emit.edge("SIMILAR_BODY", { from: `Function:${key}`, to: `Function:${other.props.key}` },
          { evidence: [fn, other], rule: "same-tokens-except-identifiers-at-least-30",
            note: "Identifier spelling is ignored, including property names. Review candidate, not semantic equivalence." });
      }
    }
  },
});
