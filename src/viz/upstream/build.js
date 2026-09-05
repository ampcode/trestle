import { execFileSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const source = join(import.meta.dirname, 'source');
const output = join(source, 'dist');
const served = join(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Always use the committed lock, including on a fresh clone. Never patch dependencies.
execFileSync(npm, ['ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
execFileSync(npm, ['run', 'typecheck'], { cwd: source, stdio: 'inherit' });
if (!process.argv.includes('--check')) {
  try {
    execFileSync(npm, ['run', 'build'], { cwd: source, stdio: 'inherit' });
    // Publish only after a successful build; never empty the source/license directory.
    rmSync(join(served, 'assets'), { recursive: true, force: true });
    cpSync(join(output, 'assets'), join(served, 'assets'), { recursive: true });
    cpSync(join(output, 'index.html'), join(served, 'index.html'));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}
