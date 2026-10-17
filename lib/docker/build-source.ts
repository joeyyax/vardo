// Per-environment build tree: the deployed commit's files without .git, so a fetch never changes the build context.

import { cp, mkdir, readFile, rm, stat } from "fs/promises";
import { join, resolve } from "path";
import { parseComposeYaml } from "./compose";
import { isUnder } from "./compose-root";

/** Runs git against the shared checkout with extra environment. */
export type BuildSourceGit = (args: string[], env?: Record<string, string>) => Promise<unknown>;

/** Env var that keeps the repository's .git in the build tree. */
export const INCLUDE_GIT_ENV = "VARDO_BUILD_INCLUDE_GIT";

export function buildSourcePaths(appDir: string): { dir: string; index: string } {
  return { dir: join(appDir, "build-source"), index: join(appDir, "build-source.index") };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** Brings `<appDir>/build-source` to `sha` with its own index, rewriting only files that changed. */
export async function syncBuildSource(opts: {
  git: BuildSourceGit;
  appDir: string;
  sha: string;
}): Promise<string> {
  const { dir, index } = buildSourcePaths(opts.appDir);
  if (!(await exists(index)) || !(await exists(dir))) {
    await rm(dir, { recursive: true, force: true });
    await rm(index, { force: true });
  }
  await mkdir(dir, { recursive: true });
  await rm(join(dir, ".git"), { recursive: true, force: true });

  const env = { GIT_INDEX_FILE: index };
  try {
    await opts.git(["--work-tree", dir, "read-tree", "--reset", "-u", opts.sha], env);
  } catch {
    // A tree the index no longer describes: start over.
    await rm(dir, { recursive: true, force: true });
    await rm(index, { force: true });
    await mkdir(dir, { recursive: true });
    await opts.git(["--work-tree", dir, "read-tree", "--reset", "-u", opts.sha], env);
  }
  return dir;
}

/** Copies the checkout's .git into the build tree, at `sha`, for a build that reads it. */
export async function copyGitDir(opts: { git: BuildSourceGit; repoDir: string; dir: string; sha: string }): Promise<void> {
  const gitDir = join(opts.dir, ".git");
  await cp(join(opts.repoDir, ".git"), gitDir, { recursive: true, verbatimSymlinks: true });
  await opts.git(["--git-dir", gitDir, "update-ref", "--no-deref", "HEAD", opts.sha]);
  await opts.git(["--git-dir", gitDir, "--work-tree", opts.dir, "read-tree", opts.sha]);
}

export type BuildSpec = { context: string; args?: Record<string, string> | string[] } & Record<string, unknown>;

/** Adds each of `vars` to a compose build's args unless the file sets it. */
export function withBuildVarArgs(build: BuildSpec, vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    const args = build.args;
    if (Array.isArray(args)) {
      if (!args.some((a) => a === key || a.startsWith(`${key}=`))) args.push(`${key}=${value}`);
    } else if (args && typeof args === "object") {
      if (!(key in args)) args[key] = value;
    } else {
      build.args = { [key]: value };
    }
  }
}

/** Fetches one branch, shallow, into its own remote ref, whatever refspec the clone was made with. */
export function branchFetchArgs(branch: string): string[] {
  return ["fetch", "--depth", "1", "--", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`];
}

/** `COPY .git`, a `.git` bind mount, or git reading the repository in a RUN step. */
const GIT_IN_DOCKERFILE = [
  /^\s*(?:COPY|ADD)\b[^\n]*?\s(?:\.\/)?\.git(?:\/|\s|$)/im,
  /--mount=[^\s]*\b(?:source|src)=(?:\.\/)?\.git\b/i,
  /\bgit\s+(?:-C\s+\S+\s+)?(?:rev-parse|describe|log|rev-list|show|symbolic-ref|branch|status)\b/i,
];

/** Whether a Dockerfile reads the repository's .git. */
export function dockerfileNeedsGit(content: string): boolean {
  return GIT_IN_DOCKERFILE.some((re) => re.test(content));
}

/** Compose candidates in lookup order. */
export function composeCandidates(composeFilePath: string | null | undefined): string[] {
  return [composeFilePath || "docker-compose.yml", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
}

/** Dockerfile contents a deploy of `root` would build: the app's own, plus every compose service's. */
export async function dockerfilesIn(root: string, opts: {
  dockerfilePath: string | null;
  composeFilePath: string | null;
  compose: boolean;
}): Promise<string[]> {
  const read = (path: string) => readFile(path, "utf-8").catch(() => null);
  const found: string[] = [];
  if (opts.compose) {
    for (const candidate of composeCandidates(opts.composeFilePath)) {
      const yaml = await read(join(root, candidate));
      if (yaml === null) continue;
      let services: Record<string, { build?: unknown }> = {};
      try {
        services = ((parseComposeYaml(yaml) as { services?: typeof services }).services) ?? {};
      } catch {
        break;
      }
      for (const svc of Object.values(services)) {
        const b = svc?.build;
        if (b === undefined || b === null) continue;
        const spec = typeof b === "object" ? (b as Record<string, unknown>) : { context: b };
        if (typeof spec.dockerfile_inline === "string") {
          found.push(spec.dockerfile_inline);
          continue;
        }
        const context = resolve(root, String(spec.context ?? "."));
        const file = resolve(context, typeof spec.dockerfile === "string" ? spec.dockerfile : "Dockerfile");
        if (!isUnder(file, root)) continue;
        const content = await read(file);
        if (content !== null) found.push(content);
      }
      return found;
    }
  }
  const own = await read(join(root, opts.dockerfilePath || "Dockerfile"));
  if (own !== null) found.push(own);
  return found;
}
