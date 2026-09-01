import { pipeline } from "trestle";

/**
 * Seed pipeline: a file-inventory fact emitter. Edit this into your real
 * extraction — add tools via ctx.run, remote inputs via ctx.acquire, and
 * wrap per-unit work in ctx.memo for incremental re-extraction.
 */
export default pipeline(async ({ corpus, memo, emit }) => {
  for (const path of corpus.list()) {
    await memo(`inventory:${path}`, [path], () => {
      const text = corpus.read(path);
      const dot = path.lastIndexOf(".");
      emit({
        kind: "file-inventoried",
        sourcePath: path,
        props: {
          path,
          extension: dot > 0 ? path.slice(dot + 1) : undefined,
          bytes: Buffer.byteLength(text),
        },
      });
    });
  }
});
