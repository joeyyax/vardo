// Path containment for an app's own directories.

import { existsSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { DeployBlockedError } from "./errors";

/** True when `path` is `dir` or inside it. */
export function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Real path of `path`, resolving symlinks in the deepest part that exists. */
export function realpathLenient(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

/** `repoDir/rootDirectory`, refused when it leaves the repo. */
export function appRootDir(repoDir: string, rootDirectory: string | null | undefined): string {
  if (!rootDirectory) return repoDir;
  const root = resolve(join(repoDir, rootDirectory));
  const repo = realpathLenient(repoDir);
  if (!isUnder(root, resolve(repoDir)) || !isUnder(realpathLenient(root), repo)) {
    throw new DeployBlockedError(`Couldn't deploy: root directory "${rootDirectory}" is outside the repository.`);
  }
  return root;
}
