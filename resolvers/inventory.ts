import { resolver, mapFacts } from "trestle";

/**
 * Seed resolver: P0 fact mapping. The survey (`trestle survey`) tells you
 * which resolver to write next, ranked by unresolved population.
 */
export default resolver({
  name: "inventory",
  phase: 10,
  consumes: { facts: ["file-inventoried"] },
  run(slice, emit) {
    mapFacts(slice, emit, {
      "file-inventoried": [
        {
          node: (f) => ({
            kind: "File",
            // SAFETY: file-inventoried declares path as required t.string(); insertion validates it.
            identity: { path: f.props.path as string },
            props: { extension: f.props.extension },
          }),
          rule: "file-node",
        },
      ],
    });
  },
});
