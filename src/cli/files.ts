import { lstatSync } from "node:fs";
import { join } from "node:path";

/** Installers never follow project symlinks or manifest paths outside the project. */
export function checkedPath(root: string, rel: string): string {
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\:]/.test(part))) throw new Error(`invalid installation path: ${rel}`);
  let path = root;
  for (const part of parts) {
    path = join(path, part);
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${rel}: refusing to follow a symlink`);
  }
  return path;
}
