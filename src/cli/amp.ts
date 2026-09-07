import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { isProperties, isString } from "../profile/value.ts";
import { PACKAGE_ROOT, VERSION, hasIsolatedTooling, packageManager } from "./package.ts";
import { checkedPath } from "./files.ts";

const ASSETS = join(PACKAGE_ROOT, "assets");
const MANIFEST = ".amp/trestle-install.json";
const SERVICES = ".amp/services.yaml";
const MARKERS = {
  "AGENTS.md": ["<!-- trestle:amp begin -->", "<!-- trestle:amp end -->"],
  ".agents/setup:root": ["# trestle:amp-root begin", "# trestle:amp-root end"],
  ".agents/setup": ["# trestle:amp-bootstrap begin", "# trestle:amp-bootstrap end"],
} as const;
interface Manifest {
  version: 1;
  packageVersion: string;
  files: Record<string, string>;
  sections: Record<string, string>;
  service: string;
}
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const read = (path: string): string => existsSync(path) ? readFileSync(path, "utf8") : "";

function isStringMap(value: unknown): value is Record<string, string> {
  return isProperties(value) && Object.values(value).every(isString);
}

function isManifest(value: unknown): value is Manifest {
  return isProperties(value) && value.version === 1 && isString(value.packageVersion)
    && isStringMap(value.files) && isStringMap(value.sections) && isString(value.service);
}

function parseManifest(root: string): Manifest | undefined {
  const text = read(checkedPath(root, MANIFEST));
  if (!text) return undefined;
  const value: unknown = JSON.parse(text);
  if (!isManifest(value) || Object.keys(value.files).some((rel) =>
    !rel.startsWith(".amp/plugins/trestle/") && !rel.startsWith(".agents/skills/trestle-"))) {
    throw new Error(`${MANIFEST}: invalid Trestle Amp manifest`);
  }
  for (const rel of Object.keys(value.files)) checkedPath(root, rel);
  return value;
}

function ownedAssets(): Map<string, string> {
  const files = new Map([
    [".amp/plugins/trestle/index.js", readFileSync(join(PACKAGE_ROOT, "dist", "amp", "trestle.js"), "utf8")],
    [".amp/plugins/trestle/package.json", '{"private":true,"type":"module"}\n'],
  ]);
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(ASSETS, "skills", rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(child);
      else files.set(`.agents/skills/${child}`, read(join(ASSETS, "skills", child)));
    }
  };
  walk("");
  return files;
}

function sections(root: string): Record<string, string> {
  const isolated = hasIsolatedTooling(root);
  const install = isolated ? "npm --prefix trestle install --workspaces=false" : `${packageManager(root)} install`;
  const cli = `${isolated ? "trestle/" : ""}node_modules/trestle/bin/trestle.js`;
  const bodies = {
    "AGENTS.md": "- Trestle graph code lives under `trestle/` by default. Read `trestle.config.mts` (or legacy `trestle.config.ts`) for configured paths.\n- Load the matching `trestle-*` skill before graph vocabulary, extraction, resolver, or survey work.\n- For frontend/display work, load `trestle-visualizing`: configure the bundled explorer around semantic entities and relationships, size the visible node/edge pools, and inspect the rendered result.\n- New projects isolate the SDK and TypeScript under `trestle/`: use `npx --prefix trestle trestle` and `npm --prefix trestle run typecheck`. Leave application dependencies alone.\n- Import the public `trestle` SDK; do not import engine internals or edit application sources merely to construct the graph.",
    ".agents/setup:root": 'TRESTLE_SETUP_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit $?',
    ".agents/setup": `# Run after application setup has installed its toolchain.\n(\n  cd "$TRESTLE_SETUP_ROOT" &&\n  ${install} &&\n  node ${cli} corpus restore\n) || exit $?\nunset TRESTLE_SETUP_ROOT`,
  };
  return Object.fromEntries(Object.entries(bodies).map(([key, body]) => {
    // SAFETY: bodies and MARKERS declare the same owned section keys.
    const [begin, end] = MARKERS[key as keyof typeof MARKERS];
    return [key, `${begin}\n${body}\n${end}`];
  }));
}

function replaceSection(original: string, path: keyof typeof MARKERS, previous: string | undefined, addition: string): string {
  const [begin, end] = MARKERS[path];
  const start = original.indexOf(begin);
  const finish = original.indexOf(end);
  if (start < 0 && finish < 0) {
    if (!addition) return original;
    if (path === ".agents/setup:root") {
      const at = original.startsWith("#!") ? original.indexOf("\n") + 1 : 0;
      return `${original.slice(0, at)}\n${addition}\n${original.slice(at)}`;
    }
    return `${original}${original && !original.endsWith("\n") ? "\n" : ""}\n${addition}\n`;
  }
  if (start < 0 || finish < start || original.indexOf(begin, start + begin.length) >= 0
    || original.indexOf(end, finish + end.length) >= 0) throw new Error(`${path}: malformed Trestle-owned section`);
  if (!previous || original.slice(start, finish + end.length) !== previous) throw new Error(`${path}: Trestle-owned section was modified`);
  if (addition) return original.slice(0, start) + addition + original.slice(finish + end.length);
  return original.slice(0, start).replace(/\n$/, "") + original.slice(finish + end.length).replace(/^\n/, "");
}

function sharedFiles(root: string, previous: Manifest | undefined, additions?: Record<string, string>): Map<string, string> {
  const files = new Map<string, string>();
  for (const key of Object.keys(MARKERS)) {
    // SAFETY: key comes from MARKERS, not from the manifest.
    const section = key as keyof typeof MARKERS;
    const rel = section === ".agents/setup:root" ? ".agents/setup" : section;
    const path = checkedPath(root, rel);
    const original = files.get(rel) ?? (existsSync(path) ? read(path) : additions && rel === ".agents/setup" ? "#!/usr/bin/env bash\nset -euo pipefail\n" : "");
    if (additions && rel === ".agents/setup" && original.startsWith("#!")
      && !/^#![^\n]*\b(?:bash|sh)\s*(?:\n|$)/.test(original)) throw new Error(".agents/setup: automatic integration requires a bash or sh script");
    files.set(rel, replaceSection(original, section, previous?.sections[section], additions?.[section] ?? ""));
  }
  return files;
}

function service(root: string) {
  const prefix = hasIsolatedTooling(root) ? "trestle/" : "";
  return {
    command: `node ${prefix}node_modules/trestle/bin/trestle.js serve --host 0.0.0.0 --port "$PORT"`,
    health: "/health",
    portal: { title: "Knowledge Graph", description: "Explore the live Trestle graph; MCP at /mcp." },
  };
}

function mergeService(root: string, previous: Manifest | undefined, remove: boolean): string {
  const doc = parseDocument(read(checkedPath(root, SERVICES)) || "services: {}\n");
  if (doc.errors.length || !isMap(doc.contents)) throw new Error(`${SERVICES}: expected a YAML mapping`);
  if (doc.has("services") && !isMap(doc.get("services"))) throw new Error(`${SERVICES}: services must be a mapping`);
  const existing = doc.getIn(["services", "trestle"]);
  if (doc.hasIn(["services", "trestle"]) && (!previous || JSON.stringify(existing) !== previous.service)) throw new Error(`${SERVICES}: trestle service conflicts or was modified`);
  if (remove) doc.deleteIn(["services", "trestle"]);
  else doc.setIn(["services", "trestle"], service(root));
  return doc.toString();
}

export function installAmp(root: string): void {
  const previous = parseManifest(root);
  for (const name of ["trestle.ts", "trestle.js"]) {
    if (existsSync(checkedPath(root, `.amp/plugins/${name}`))) throw new Error(`.amp/plugins/${name}: conflicting unmanaged plugin; review and move it aside before installing`);
  }
  const assets = ownedAssets();
  for (const rel of new Set([...assets.keys(), ...Object.keys(previous?.files ?? {})])) {
    const path = checkedPath(root, rel);
    if (existsSync(path) && hash(readFileSync(path)) !== previous?.files[rel]) throw new Error(`${rel}: refusing to overwrite a conflicting or modified file`);
  }
  const additions = sections(root);
  const shared = sharedFiles(root, previous, additions);
  const services = mergeService(root, previous, false);
  const manifest: Manifest = { version: 1, packageVersion: VERSION, files: {}, sections: additions, service: JSON.stringify(service(root)) };
  for (const [rel, content] of [...assets, ...shared, [SERVICES, services]]) {
    const path = checkedPath(root, rel);
    const existed = existsSync(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (rel === ".agents/setup" && !existed) chmodSync(path, 0o755);
    if (assets.has(rel)) manifest.files[rel] = hash(content);
  }
  for (const rel of Object.keys(previous?.files ?? {})) {
    if (!assets.has(rel)) rmSync(checkedPath(root, rel), { force: true });
  }
  writeFileSync(checkedPath(root, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function uninstallAmp(root: string): void {
  const previous = parseManifest(root);
  if (!previous) return;
  for (const [rel, expected] of Object.entries(previous.files)) {
    const path = checkedPath(root, rel);
    if (existsSync(path) && hash(readFileSync(path)) !== expected) throw new Error(`${rel}: refusing to remove a modified file`);
  }
  const shared = sharedFiles(root, previous);
  const services = mergeService(root, previous, true);
  for (const [rel, content] of [...shared, [SERVICES, services]]) writeFileSync(checkedPath(root, rel), content);
  for (const rel of Object.keys(previous.files)) rmSync(checkedPath(root, rel), { force: true });
  rmSync(checkedPath(root, MANIFEST));
}
