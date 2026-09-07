#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A global installation bootstraps projects; an existing project's pin owns execution.
let local;
for (let dir = process.cwd(); ; dir = dirname(dir)) {
  const candidate = join(dir, 'node_modules/trestle/bin/trestle.js');
  if (existsSync(candidate)) { local = realpathSync(candidate); break; }
  if (existsSync(join(dir, '.git')) || dirname(dir) === dir) break;
}
if (local && local !== realpathSync(fileURLToPath(import.meta.url))) {
  await import(pathToFileURL(local).href);
} else {
  const { runCli } = await import(new URL('../dist/cli/main.js', import.meta.url));
  runCli(process.argv.slice(2), process.cwd()).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
