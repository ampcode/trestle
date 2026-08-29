import { pipeline } from "trestle";

/**
 * Transcription only: regexes over COBOL and JCL. The pipeline never
 * infers — SELECT/ASSIGN, OPEN modes, CALL literals, EXEC PGM and DD
 * cards are all literally present in the artifacts. Joining them is
 * the resolvers' job.
 */
export default pipeline(async ({ corpus, memo, emit }) => {
  for (const path of corpus.list(".cbl")) {
    await memo(`cobol:${path}`, [path], () => {
      const text = corpus.read(path);
      const lines = text.split("\n");
      const program = matchFirst(text, /PROGRAM-ID\.\s+(\w+)/)?.[1];
      if (!program) return;

      emit({
        kind: "unit-defined",
        sourcePath: path,
        locator: { type: "lines", startLine: lineOf(lines, "PROGRAM-ID") },
        props: { name: program, unitKind: "program" },
      });

      // OPEN modes per select-name (transcribed from the same file).
      const modes = new Map<string, "input" | "output" | "i-o">();
      for (const m of text.matchAll(/OPEN\s+(INPUT|OUTPUT|I-O)\s+(\w+)/g)) {
        modes.set(m[2]!, m[1]!.toLowerCase() as "input" | "output" | "i-o");
      }

      for (const m of text.matchAll(/SELECT\s+(\w+)\s+ASSIGN\s+TO\s+(\w+)/g)) {
        emit({
          kind: "binding-observed",
          sourcePath: path,
          locator: { type: "lines", startLine: lineAt(text, lines, m.index) },
          props: {
            bindingKind: "file-control",
            program,
            selectName: m[1]!,
            assignTarget: m[2]!,
            mode: modes.get(m[1]!),
          },
        });
      }

      for (const m of text.matchAll(/CALL\s+'(\w+)'/g)) {
        emit({
          kind: "call-observed",
          sourcePath: path,
          locator: { type: "lines", startLine: lineAt(text, lines, m.index) },
          props: { caller: program, callee: m[1]!, dispatch: "static" },
        });
      }
    });
  }

  for (const path of corpus.list(".jcl")) {
    await memo(`jcl:${path}`, [path], () => {
      const text = corpus.read(path);
      const lines = text.split("\n");
      let job: string | undefined;
      let step: string | undefined;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const jobM = line.match(/^\/\/(\w+)\s+JOB\b/);
        if (jobM) {
          job = jobM[1]!;
          emit({
            kind: "unit-defined",
            sourcePath: path,
            locator: { type: "lines", startLine: i + 1 },
            props: { name: job, unitKind: "job" },
          });
          continue;
        }
        const execM = line.match(/^\/\/(\w+)\s+EXEC\s+PGM=(\w+)/);
        if (execM && job) {
          step = execM[1]!;
          emit({
            kind: "execution-observed",
            sourcePath: path,
            locator: { type: "lines", startLine: i + 1 },
            props: { job, step, executes: execM[2]! },
          });
          continue;
        }
        const ddM = line.match(/^\/\/(\w+)\s+DD\s+DSN=([A-Z0-9.]+)(?:,DISP=(\S+))?/);
        if (ddM && job && step) {
          emit({
            kind: "binding-observed",
            sourcePath: path,
            locator: { type: "lines", startLine: i + 1 },
            props: {
              bindingKind: "dd",
              job,
              step,
              ddName: ddM[1]!,
              dataset: ddM[2]!,
              disp: ddM[3],
            },
          });
        }
      }
    });
  }
});

function matchFirst(text: string, re: RegExp): RegExpMatchArray | null {
  return text.match(re);
}
function lineOf(lines: string[], needle: string): number {
  return lines.findIndex((l) => l.includes(needle)) + 1;
}
function lineAt(text: string, lines: string[], index: number | undefined): number {
  if (index === undefined) return 1;
  return text.slice(0, index).split("\n").length;
}
