import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repo = join(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('packed CLI and SDK bootstrap and run outside the engine checkout', { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trestle-package-'));
  const project = join(dir, 'application');
  const run = (command, args, cwd = project) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [packed] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], repo));
    assert.ok(packed.files.some(file => file.path === 'dist/index.d.ts'));
    assert.ok(packed.files.some(file => file.path === 'src/viz/index.html'));
    assert.ok(!packed.files.some(file => file.path === 'src/cli/main.ts'));
    mkdirSync(project);
    // Preserve a real application's CommonJS mode and scripts.
    writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'commonjs', scripts: { test: 'echo existing' } }));
    run(npm, ['install', '--save-dev', join(dir, packed.filename)]);
    run('git', ['init', '--quiet']);
    writeFileSync(join(project, 'hello.js'), 'module.exports = 42;\n');
    mkdirSync(join(project, '.agents'));
    writeFileSync(join(project, '.agents/setup'), '#!/bin/sh\necho application-setup\ncd /\n');
    const cli = join(project, 'node_modules/trestle/bin/trestle.js');
    assert.match(run(process.execPath, [cli, 'init', '--amp']), /Trestle project ready/);
    assert.equal(JSON.parse(readFileSync(join(project, 'package.json'))).type, 'commonjs');
    assert.match(run(process.execPath, [cli, 'init', '--amp']), /existing graph files preserved/);
    run(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '-p', 'trestle/tsconfig.json']);
    run(process.execPath, ['--input-type=module', '-e', 'import { defineProfile, pipeline, resolver } from "trestle"; import { Coordination } from "trestle/coordination"; if (![defineProfile, pipeline, resolver, Coordination].every(x => typeof x === "function")) process.exit(1)']);
    assert.match(run(process.execPath, [cli, 'profile', 'build']), /profile/);
    assert.match(run(process.execPath, [cli, 'extract']), /0 failed/);
    assert.match(run(process.execPath, [cli, 'extract']), /0 cells computed/);
    run(process.execPath, [cli, 'resolve']);
    run(process.execPath, [cli, 'survey']);
    run(process.execPath, [cli, 'doctor', '--strict']);
    run(process.execPath, [cli, 'project', 'build']);
    assert.match(run(process.execPath, [cli, 'project', 'query', 'MATCH (f:File) RETURN f.path']), /hello.js/);
    // The global entrypoint must defer to the project's installed package, even in a subdirectory.
    assert.equal(run(process.execPath, [join(repo, 'bin/trestle.js'), '--version'], join(project, 'trestle')), run(process.execPath, [cli, '--version']));
    const plugin = await import(pathToFileURL(join(project, '.amp/plugins/trestle/index.js')).href);
    const tools = [];
    plugin.default({ registerTool: tool => tools.push(tool.name) });
    assert.deepEqual(tools.sort(), ['trestle_amp', 'trestle_auth', 'trestle_call', 'trestle_query']);
    run('bash', ['-n', '.agents/setup']);
    run('bash', ['.agents/setup']);
    run('bash', ['.agents/setup']);
    const { startServer } = await import(pathToFileURL(join(project, 'node_modules/trestle/dist/server/serve.js')).href);
    const server = await startServer({
      dbPath: join(project, 'trestle/.state/trestle.db'),
      projectionPath: join(project, 'trestle/.state/projection.lbug'),
      lockPath: join(project, 'trestle/profile.lock.json'),
    }, { port: 0 });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      assert.equal((await fetch(`${base}/health`)).status, 200);
      const html = await (await fetch(base)).text();
      const asset = html.match(/src="(\/assets\/[^"]+)"/);
      assert.ok(asset, 'installed package serves built explorer HTML');
      assert.equal((await fetch(`${base}${asset[1]}`)).status, 200);
      const response = await fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      assert.ok((await response.json()).result.tools.some(tool => tool.name === 'graph_query'));
    } finally { await server.close(); }
    run(process.execPath, [cli, 'amp', 'uninstall']);
    assert.ok(existsSync(join(project, 'trestle/.state/trestle.db')));
    assert.ok(existsSync(join(project, 'trestle/profile.ts')));
    assert.ok(!existsSync(join(project, '.amp/plugins/trestle/index.js')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
