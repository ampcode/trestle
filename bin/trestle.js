#!/usr/bin/env node
import { runCli } from "../src/cli/main.ts";

runCli(process.argv.slice(2), process.cwd()).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
