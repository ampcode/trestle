import ts from "typescript";
import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { pipeline } from "../../../src/index.ts";

/** Named top-level functions/arrow bindings and named-class methods; not a whole-program liveness proof. */
export default pipeline(async ({ corpus, memo, emit }) => {
  const root = resolve(import.meta.dirname, "../../..");
  const paths = corpus.list().filter(path =>
    /\.[cm]?[jt]sx?$/.test(path)
    && /^(src\/|tests\/|bin\/|extract\/|resolvers\/|\.amp\/plugins\/|[^/]+$)/.test(path)
    && !path.startsWith("src/viz/assets/") && !path.endsWith(".d.ts"));
  await memo(`typescript:${ts.version}`, [...paths, "package.json", "tsconfig.json"], () => {
    const sources = new Map(paths.map(path => [resolve(root, path), corpus.read(path)]));
    const config = ts.parseConfigFileTextToJson("tsconfig.json", corpus.read("tsconfig.json"));
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
    const options = ts.convertCompilerOptionsFromJson(config.config.compilerOptions, root).options;
    options.allowJs = true;
    options.jsx = ts.JsxEmit.React;
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile;
    const fileExists = host.fileExists;
    host.readFile = path => sources.get(resolve(path)) ?? readFile(path);
    host.fileExists = path => sources.has(resolve(path)) || fileExists(path);
    const program = ts.createProgram([...sources.keys()], options, host);
    const errors = program.getSyntacticDiagnostics();
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, host));
    const checker = program.getTypeChecker();
    const authority = { tool: "typescript", version: ts.version };
    const declarations = new Map<ts.Node, { key: string; name: ts.Node }>();
    const files = program.getSourceFiles().filter(file => sources.has(resolve(file.fileName)));
    const locator = (node: ts.Node) => {
      const file = node.getSourceFile();
      const start = file.getLineAndCharacterOfPosition(node.getStart());
      const end = file.getLineAndCharacterOfPosition(node.getEnd());
      return { type: "lines", startLine: start.line + 1, startColumn: start.character + 1, endLine: end.line + 1 };
    };
    for (const file of files) {
      const path = relative(root, file.fileName);
      emit({ kind: "file-parsed", sourcePath: path, authority, props: { path } });
      const declare = (name: ts.Node, body: ts.Node, qualified: string, category: string, exported: boolean) => {
        const symbol = checker.getSymbolAtLocation(name);
        if (!symbol) return;
        const key = `${path}::${qualified}`;
        declarations.set(name.parent, { key, name });
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, body.getText());
        const tokens: string[] = [];
        const normalizedTokens: string[] = [];
        while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
          tokens.push(scanner.getTokenText());
          normalizedTokens.push(scanner.getToken() === ts.SyntaxKind.Identifier ? "<identifier>" : scanner.getTokenText());
        }
        emit({ kind: "function-declared", sourcePath: path, locator: locator(name.parent), authority, props: {
          key, name: qualified, path, category, exported, tokens: tokens.length,
          bodyHash: createHash("sha256").update(JSON.stringify(tokens)).digest("hex"),
          normalizedBodyHash: createHash("sha256").update(JSON.stringify(normalizedTokens)).digest("hex"),
        } });
      };
      for (const statement of file.statements) {
        const exported = ts.canHaveModifiers(statement)
          && (ts.getModifiers(statement)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false);
        if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
          declare(statement.name, statement.body, statement.name.text, "function", exported);
        }
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer
              && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
              declare(declaration.name, declaration.initializer.body, declaration.name.text, "binding", exported);
            }
          }
        }
        if (ts.isClassDeclaration(statement) && statement.name) {
          for (const member of statement.members) {
            if (ts.isMethodDeclaration(member) && member.body) {
              declare(member.name, member.body, `${statement.name.text}.${member.name.getText()}`, "method", exported);
            }
          }
        }
      }
    }
    for (const file of files) {
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) {
          let symbol = checker.getSymbolAtLocation(node);
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          // Instantiated generic methods have transient symbols; declaration nodes retain their identity.
          // Call signatures also expose declarations behind destructured dynamic imports.
          const candidates = [...(symbol?.declarations ?? []),
            ...checker.getTypeAtLocation(node).getCallSignatures().flatMap(signature => signature.declaration ? [signature.declaration] : [])];
          const seen = new Set<string>();
          for (const declaration of candidates) {
            const target = declarations.get(declaration);
            if (target && target.name !== node && !seen.has(target.key)) {
              seen.add(target.key);
              emit({ kind: "reference-observed", sourcePath: relative(root, file.fileName), locator: locator(node),
                authority, props: { target: target.key } });
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  });
});
