import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const root = join(import.meta.dirname, '..');
// Ship the same adapter used in development, without type-only engine/Amp imports.
const source = readFileSync(join(root, '.amp/plugins/trestle.ts'), 'utf8');
const { outputText, diagnostics } = ts.transpileModule(source, {
  fileName: 'trestle.ts',
  reportDiagnostics: true,
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
if (diagnostics?.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => root,
  getNewLine: () => '\n',
}));
mkdirSync(join(root, 'dist/amp'), { recursive: true });
writeFileSync(join(root, 'dist/amp/trestle.js'), outputText);
