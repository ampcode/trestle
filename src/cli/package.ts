import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isProperties, isString, type Properties } from "../profile/value.ts";

export const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
export const VERSION: string = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;

export function projectPackage(dir: string): Properties {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return { private: true };
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isProperties(value)) throw new Error(`${path}: expected a package object`);
  return value;
}

export function packageManager(dir: string): string {
  const declared = projectPackage(dir).packageManager;
  const name = isString(declared) ? declared.split("@")[0] : undefined;
  if (name) {
    if (!["npm", "pnpm", "yarn", "bun"].includes(name)) throw new Error(`unsupported package manager: ${name}`);
    return name;
  }
  const locks = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"]];
  return locks.find(([file]) => existsSync(join(dir, file!)))?.[1] ?? "npm";
}
