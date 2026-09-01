#!/usr/bin/env node
// The engine runs from TypeScript source: the graph repo IS the trestle
// repo, so src/ is never under node_modules and Node >= 23.6 type-strips
// it natively. No build step.
const { runCli } = await import(new URL("../src/cli/main.ts", import.meta.url));

runCli(process.argv.slice(2), process.cwd()).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
