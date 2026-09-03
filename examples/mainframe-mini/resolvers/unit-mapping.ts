import { resolver, mapFacts } from "trestle";

/** P0: facts that already contain their conclusion become entities mechanically. */
export default resolver({
  name: "unit-mapping",
  phase: 10,
  consumes: { facts: ["unit-defined", "execution-observed", "call-observed"] },
  run(slice, emit) {
    mapFacts(slice, emit, {
      "unit-defined": [
        {
          when: (f) => f.props.unitKind === "program",
          node: (f) => ({
            kind: "Program",
            identity: { name: f.props.name as string },
            props: { language: "cobol" },
          }),
          rule: "program-def",
        },
        {
          when: (f) => f.props.unitKind === "job",
          node: (f) => ({ kind: "Job", identity: { name: f.props.name as string } }),
          rule: "job-def",
        },
      ],
      "execution-observed": [
        {
          edge: "EXECUTES",
          from: (f) => `Job:${f.props.job}`,
          to: (f) => `Program:${f.props.executes}`,
          props: (f) => ({ step: f.props.step }),
          rule: "jcl-exec",
        },
      ],
      "call-observed": [
        {
          when: (f) => f.props.dispatch === "static",
          edge: "CALLS",
          from: (f) => `Program:${f.props.caller}`,
          to: (f) => `Program:${f.props.callee}`,
          props: () => ({ callType: "static" }),
          rule: "static-call",
        },
      ],
    });
  },
});
