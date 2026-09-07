import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repo = join(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const applicationType of ['commonjs', 'non-node']) test(`isolated CLI and SDK in a ${applicationType} repository`, { timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'trestle-package-'));
  const project = join(dir, 'application');
  const run = (command, args, cwd = project) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const [packed] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], repo));
    assert.ok(packed.files.some(file => file.path === 'dist/index.d.ts'));
    assert.ok(packed.files.some(file => file.path === 'src/viz/index.html'));
    assert.ok(!packed.files.some(file => file.path === 'src/cli/main.ts'));
    mkdirSync(project);
    const environment = join(project, 'trestle');
    // Even a parent workspace with an older compiler must not own graph tooling.
    if (applicationType === 'commonjs') {
      writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, type: 'commonjs', scripts: { test: 'echo existing' }, workspaces: ['trestle'] }));
      run(npm, ['install', '--save-dev', '--save-exact', 'typescript@5.7.3']);
    }
    const applicationFiles = new Map(['package.json', 'package-lock.json', 'node_modules/typescript/package.json'].map(path =>
      [path, existsSync(join(project, path)) ? readFileSync(join(project, path), 'utf8') : undefined]));
    mkdirSync(environment);
    writeFileSync(join(environment, 'package.json'), '{"private":true,"type":"module"}');
    run(npm, ['--prefix', environment, 'install', '--workspaces=false', '--save-dev', join(dir, packed.filename)]);
    run('git', ['init', '--quiet']);
    const source = applicationType === 'non-node' ? 'hello.cbl' : 'hello.js';
    writeFileSync(join(project, source), applicationType === 'non-node' ? '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. HELLO.\n' : 'module.exports = 42;\n');
    mkdirSync(join(project, '.agents'));
    writeFileSync(join(project, '.agents/setup'), '#!/bin/sh\necho application-setup\ncd /\n');
    const cli = join(environment, 'node_modules/trestle/bin/trestle.js');
    assert.match(run(process.execPath, [cli, 'init', '--amp']), /Trestle project ready/);
    assert.match(run(process.execPath, [cli, 'init', '--amp']), /existing graph files preserved/);
    const visualizing = readFileSync(join(project, '.agents/skills/trestle-visualizing/SKILL.md'), 'utf8');
    const example = visualizing.match(/```ts\n([\s\S]*?)\n```/)?.[1];
    assert.ok(example, 'installed visualization guidance includes a typed config example');
    writeFileSync(join(environment, 'presentation-example.ts'), example);
    run(npm, ['--prefix', environment, 'run', 'typecheck']);
    rmSync(join(environment, 'presentation-example.ts'));
    run(process.execPath, ['--input-type=module', '-e', 'import { defineProfile, pipeline, resolver } from "trestle"; import { Coordination } from "trestle/coordination"; if (![defineProfile, pipeline, resolver, Coordination].every(x => typeof x === "function")) process.exit(1)'], environment);
    assert.match(run(process.execPath, [cli, 'profile', 'build']), /profile/);
    assert.match(run(process.execPath, [cli, 'extract']), /0 failed/);
    assert.match(run(process.execPath, [cli, 'extract']), /0 cells computed/);
    run(process.execPath, [cli, 'resolve']);
    run(process.execPath, [cli, 'survey']);
    run(process.execPath, [cli, 'doctor', '--strict']);
    run(process.execPath, [cli, 'project', 'build']);
    assert.ok(run(process.execPath, [cli, 'project', 'query', 'MATCH (f:File) RETURN f.path']).includes(source));
    // The global entrypoint must defer to the project's installed package, even in a subdirectory.
    assert.equal(run(process.execPath, [join(repo, 'bin/trestle.js'), '--version'], join(project, 'trestle')), run(process.execPath, [cli, '--version']));
    assert.equal(run(npm, ['--prefix', environment, 'exec', '--', 'trestle', '--version']), run(process.execPath, [cli, '--version']));
    const plugin = await import(pathToFileURL(join(project, '.amp/plugins/trestle/index.js')).href);
    const tools = [];
    plugin.default({ registerTool: tool => tools.push(tool.name) });
    assert.deepEqual(tools.sort(), ['trestle_amp', 'trestle_auth', 'trestle_call', 'trestle_query']);
    run('bash', ['-n', '.agents/setup']);
    run('bash', ['.agents/setup']);
    run('bash', ['.agents/setup']);
    assert.match(readFileSync(join(project, '.amp/services.yaml'), 'utf8'), /node trestle\/node_modules\/trestle\/bin\/trestle.js serve/);
    for (const [path, before] of applicationFiles) {
      assert.equal(existsSync(join(project, path)) ? readFileSync(join(project, path), 'utf8') : undefined, before, `${path} unchanged`);
    }
    assert.ok(existsSync(join(environment, 'package-lock.json')));
    const { startServer } = await import(pathToFileURL(join(environment, 'node_modules/trestle/dist/server/serve.js')).href);
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
