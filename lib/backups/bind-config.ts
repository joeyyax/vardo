// Bind mounts that carry an app's checked-out config rather than its data. Judged at run time.

import { stat } from "fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { PROJECTS_DIR } from "@/lib/paths";
import { execFileAsync } from "@/lib/utils/exec";

/** Slot directories, which link the repo's entries. */
const SLOTS = new Set(["blue", "green", "local", "current"]);

/** Single files that hold data, not config. */
const DATA_FILE = /\.(db|sqlite3?|db3|kdbx|realm)$/i;

const GIT_TIMEOUT_MS = 10_000;

export type BindProbe = {
  /** True for a regular file, null when it can't be read. */
  isFile(path: string): Promise<boolean | null>;
  /** True when git tracks `rel` in `repo` with nothing modified, untracked or ignored under it. Null when unknown. */
  cleanInGit(repo: string, rel: string): Promise<boolean | null>;
};

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { timeout: GIT_TIMEOUT_MS });
  return String(stdout);
}

export const fsProbe: BindProbe = {
  async isFile(path) {
    try {
      return (await stat(path)).isFile();
    } catch {
      return null;
    }
  },
  async cleanInGit(repo, rel) {
    try {
      if (!(await git(repo, ["ls-files", "--", rel])).trim()) return false;
      const dirty = await git(repo, ["status", "--porcelain", "--ignored=matching", "--untracked-files=all", "--", rel]);
      return dirty.trim() === "";
    } catch {
      return null;
    }
  },
};

/** The repo and repo-relative path a source under the apps directory points into, or null. */
export function repoPathOf(source: string, projectsDir = PROJECTS_DIR): { repo: string; rel: string } | null {
  const rel = relative(projectsDir, resolve(source));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const [app, ...rest] = rel.split(sep);
  const repo = join(projectsDir, app, "repo");
  if (rest[0] === "repo") return { repo, rel: rest.slice(1).join("/") || "." };
  // `<app>/<slot>/x` or `<app>/<env>/<slot>/x`.
  const slot = rest.slice(0, 2).findIndex((p) => SLOTS.has(p));
  const inSlot = slot >= 0 ? rest.slice(slot + 1) : [];
  return inSlot.length ? { repo, rel: inSlot.join("/") } : null;
}

/** Why a bind source is config rather than data, or null. Only sources under the apps directory are judged. */
export async function configBindReason(
  source: string | null,
  opts: { projectsDir?: string; probe?: BindProbe } = {},
): Promise<string | null> {
  if (!source) return null;
  const projectsDir = opts.projectsDir ?? PROJECTS_DIR;
  const probe = opts.probe ?? fsProbe;
  const rel = relative(projectsDir, resolve(source));
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;

  const inRepo = repoPathOf(source, projectsDir);
  if (inRepo && (await probe.cleanInGit(inRepo.repo, inRepo.rel))) return "Config from the app's repo";
  if (!DATA_FILE.test(source) && (await probe.isFile(source))) return "Single config file";
  return null;
}

/** Whether a selected volume is checked-out config the engine leaves out. Dumps and `stateful` volumes always back up. */
export async function skipsAsConfig(vol: {
  type: "named" | "bind";
  source: string | null;
  backupStrategy: string;
  durability: string | null;
}): Promise<string | null> {
  if (vol.type !== "bind" || vol.backupStrategy === "dump" || vol.durability === "stateful") return null;
  return configBindReason(vol.source);
}
