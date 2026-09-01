#!/usr/bin/env node
// Prefer the compiled build (required when installed under node_modules,
// where Node refuses to type-strip); fall back to TS source in a fresh
// clone that has not run `npm install` yet.
let runCli;
try {
  ({ runCli } = await import(new URL("../dist/cli/main.js", import.meta.url)));
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  ({ runCli } = await import(new URL("../src/cli/main.ts", import.meta.url)));
}

runCli(process.argv.slice(2), process.cwd()).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
