import { defineProfile, t } from "trestle";

export default defineProfile({
  nodes: {
    Program: { identity: ["name"], props: { language: t.enum("cobol", "asm").optional() } },
    Job: { identity: ["name"] },
    Dataset: { identity: ["name"] },
  },
  edges: {
    // Same program, same dataset, different step = distinct edges: the
    // executionContext identity prop keeps them apart (context-distinct reads).
    READS: {
      from: ["Program"],
      to: ["Dataset"],
      props: { executionContext: t.string(), ddName: t.string().optional() },
      identity: ["executionContext"],
    },
    WRITES: {
      from: ["Program"],
      to: ["Dataset"],
      props: { executionContext: t.string(), ddName: t.string().optional() },
      identity: ["executionContext"],
    },
    UPDATES: {
      from: ["Program"],
      to: ["Dataset"],
      props: { executionContext: t.string(), ddName: t.string().optional() },
      identity: ["executionContext"],
    },
    EXECUTES: { from: ["Job"], to: ["Program"], props: { step: t.string().optional() } },
    CALLS: { from: ["Program"], to: ["Program"], props: { callType: t.enum("static", "dynamic").optional() } },
  },
  facts: {
    "unit-defined": {
      version: 1,
      props: { name: t.string(), unitKind: t.enum("program", "job") },
    },
    "call-observed": {
      version: 1,
      props: { caller: t.string(), callee: t.string(), dispatch: t.enum("static", "dynamic") },
    },
    "binding-observed": {
      version: 1,
      props: {
        bindingKind: t.enum("file-control", "dd"),
        // file-control side
        program: t.string().optional(),
        selectName: t.string().optional(),
        assignTarget: t.string().optional(),
        mode: t.enum("input", "output", "i-o").optional(),
        // dd side
        job: t.string().optional(),
        step: t.string().optional(),
        ddName: t.string().optional(),
        dataset: t.string().optional(),
        disp: t.string().optional(),
      },
    },
    "execution-observed": {
      version: 1,
      props: { job: t.string(), step: t.string(), executes: t.string() },
    },
  },
});
