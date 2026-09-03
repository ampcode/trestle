import { resolver, rules } from "trestle";
import type { FactRow } from "trestle";

/**
 * P1 binding join — the signature mainframe move: COBOL `ASSIGN TO ddname`
 * ⋈ JCL steps executing the program ⋈ DD cards allocating that ddname.
 * Evidence cites BOTH sides of the join; unmatched references become claims.
 */
export default resolver({
  name: "dd-resolution",
  phase: 20,
  consumes: { facts: ["binding-observed", "execution-observed"] },

  run(slice, emit) {
    // 1. INDEX
    const fileControls = slice.facts("binding-observed").where((f) => f.props.bindingKind === "file-control");
    const ddCards = slice.index("binding-observed", (f) =>
      f.props.bindingKind === "dd" ? [f.props.job as string, f.props.step as string, f.props.ddName as string] : null,
    );
    const stepsExecuting = slice.index("execution-observed", (f) => [f.props.executes as string]);

    // 2. RULES — named, so every edge says which rule produced it
    const modeRules = rules<FactRow, { edge: string }>("access-mode", [
      { name: "open-input", when: (f) => f.props.mode === "input", edge: "READS" },
      { name: "open-output", when: (f) => f.props.mode === "output", edge: "WRITES" },
      { name: "open-io", when: () => true, edge: "UPDATES" },
    ]);

    // 3. JOIN
    for (const fc of fileControls) {
      const program = fc.props.program as string;
      const target = fc.props.assignTarget as string;
      const matches = stepsExecuting
        .get([program])
        .flatMap((step) => ddCards.get([step.props.job as string, step.props.step as string, target]));

      // 4. EMIT — evidence cites both sides
      for (const dd of matches) {
        const rule = modeRules.require(fc);
        emit.edge(
          rule.edge,
          {
            from: `Program:${program}`,
            to: `Dataset:${dd.props.dataset}`,
            identity: { executionContext: `${dd.props.job}.${dd.props.step}` },
          },
          {
            evidence: [fc, dd],
            rule: rule.name,
            props: { ddName: target },
          },
        );
      }

      // 5. UNMATCHED — mandatory; silence is not an option
      if (matches.length === 0) {
        emit.claim("dd-unbound", {
          about: [`Program:${program}`],
          detail: `ASSIGN TO ${target} never allocated by any step executing ${program}`,
          rule: "unmatched-assign",
        });
      }
    }
  },
});
