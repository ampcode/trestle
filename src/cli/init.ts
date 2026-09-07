import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isProperties } from "../profile/value.ts";
import { findConfig } from "./config.ts";
import { installAmp } from "./amp.ts";
import { PACKAGE_ROOT, VERSION, projectPackage } from "./package.ts";
import { checkedPath } from "./files.ts";

function templateFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? templateFiles(join(dir, entry.name), rel) : [rel];
  });
}

/** Scaffold once; subsequent runs preserve user code and retry dependency installation. */
export function initProject(cwd: string, args: string[]): void {
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (paths.length > 1 || args.some((arg) => arg.startsWith("--") && !["--amp", "--no-install"].includes(arg))) {
    throw new Error("usage: trestle init [directory] [--amp] [--no-install]");
  }
  const root = resolve(cwd, paths[0] ?? ".");
  checkedPath(root, ".gitignore");
  const existing = findConfig(root);
  if (existing && dirname(existing) !== root) throw new Error(`already inside a Trestle project at ${dirname(existing)}`);
  const application = projectPackage(root);
  if (application.name === "trestle" && application.exports) throw new Error("this is the Trestle engine package; initialize in the repository being analyzed, not the engine checkout");
  const packagePath = checkedPath(root, "trestle/package.json");
  if (existing && !existsSync(packagePath)) throw new Error("existing custom-layout project: init does not automatically migrate graph code into trestle/; keep using its existing installation or migrate the graph paths first");
  const environment = dirname(packagePath);
  const pkg = projectPackage(environment);
  if (pkg.type !== undefined && pkg.type !== "module") throw new Error("trestle/package.json: graph code requires an ESM package; refusing to change an existing module type");
  pkg.type = "module";
  pkg.private = true;
  const dependencies = pkg.dependencies;
  const devDependencies = pkg.devDependencies;
  if (dependencies !== undefined && !isProperties(dependencies)) throw new Error("trestle/package.json: invalid dependencies");
  if (devDependencies !== undefined && !isProperties(devDependencies)) throw new Error("trestle/package.json: invalid devDependencies");
  const dev = { ...devDependencies };
  if (!dependencies?.trestle && !dev.trestle) dev.trestle = VERSION;
  if (!dependencies?.typescript && !dev.typescript) dev.typescript = "^5.8.0";
  if (!dependencies?.["@types/node"] && !dev["@types/node"]) dev["@types/node"] = "^24.0.0";
  pkg.devDependencies = dev;
  if (pkg.scripts !== undefined && !isProperties(pkg.scripts)) throw new Error("trestle/package.json: invalid scripts");
  pkg.scripts = { typecheck: "tsc --noEmit -p tsconfig.json", ...pkg.scripts };

  const template = join(PACKAGE_ROOT, "assets", "project");
  const files = existing ? [] : templateFiles(template).filter((rel) => rel !== "trestle/package.json");
  for (const rel of files) {
    if (existsSync(checkedPath(root, rel))) throw new Error(`${rel}: refusing to overwrite an existing file`);
  }
  mkdirSync(environment, { recursive: true });
  for (const rel of files) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(join(template, rel)), { flag: "wx" });
  }
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  const ignorePath = join(root, ".gitignore");
  let ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
  for (const entry of ["node_modules/", "/trestle/.state/", "/.amp/portals/"]) {
    if (!ignore.split(/\r?\n/).includes(entry)) ignore += `${ignore && !ignore.endsWith("\n") ? "\n" : ""}${entry}\n`;
  }
  writeFileSync(ignorePath, ignore);
  if (!args.includes("--no-install")) {
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--prefix", environment, "install", "--workspaces=false"], { cwd: root, stdio: "inherit" });
  }
  if (args.includes("--amp")) installAmp(root);
  console.log(`Trestle project ready at ${root}${existing ? " (existing graph files preserved)" : ""}.`);
  if (args.includes("--no-install")) console.log("Run npm --prefix trestle install --workspaces=false before using the CLI or SDK.");
  console.log("Next: npx --prefix trestle trestle profile build && npx --prefix trestle trestle extract && npx --prefix trestle trestle resolve && npx --prefix trestle trestle survey");
  if (args.includes("--amp")) console.log("Amp integration installed. Reload plugins and skills in the active Amp thread, or start a new session. Run amp orb services ensure to open the graph portal.");
}
