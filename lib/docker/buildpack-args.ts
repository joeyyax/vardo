// Railpack 0.35 and Nixpacks 1.41 CLI arguments. Both take --build-cmd and --start-cmd on build and plan.

import { BUILD_KEY_LABEL, GIT_SHA_ARG } from "./build-key";

export type BuildpackEngine = "railpack" | "nixpacks";

/** App-level overrides. Empty means the engine decides. */
export type BuildOverrides = {
  buildCommand?: string | null;
  startCommand?: string | null;
};

function overrideArgs(overrides?: BuildOverrides): string[] {
  const args: string[] = [];
  const build = overrides?.buildCommand?.trim();
  const start = overrides?.startCommand?.trim();
  if (build) args.push("--build-cmd", build);
  if (start) args.push("--start-cmd", start);
  return args;
}

function envArgs(envVars?: Record<string, string>): string[] {
  const args: string[] = [];
  for (const [k, v] of Object.entries(envVars ?? {})) args.push("--env", `${k}=${v}`);
  return args;
}

/** `railpack build`. The cache key keeps each app's cache mounts (npm, .next/cache) out of other apps' builds. */
export function railpackBuildArgs(
  imageName: string,
  repoPath: string,
  cacheKey: string,
  envVars?: Record<string, string>,
  overrides?: BuildOverrides,
  noCache = false,
): string[] {
  const cache = noCache ? ["--no-cache"] : [];
  return ["build", "--name", imageName, "--cache-key", cacheKey, ...cache, ...overrideArgs(overrides), ...envArgs(envVars), repoPath];
}

/** `railpack info --format json`: the plan plus detected providers, resolved versions and detection logs. */
export function railpackPlanArgs(
  repoPath: string,
  envVars?: Record<string, string>,
  overrides?: BuildOverrides,
): string[] {
  return ["info", "--format", "json", ...overrideArgs(overrides), ...envArgs(envVars), repoPath];
}

/** `nixpacks build`. */
export function nixpacksBuildArgs(
  imageName: string,
  repoPath: string,
  envVars?: Record<string, string>,
  overrides?: BuildOverrides,
  noCache = false,
): string[] {
  return ["build", repoPath, "--name", imageName, ...overrideArgs(overrides), ...envArgs(envVars), ...(noCache ? ["--no-cache"] : [])];
}

/** `nixpacks build --out`: writes `.nixpacks/Dockerfile` into the source instead of building. */
export function nixpacksGenerateArgs(
  repoPath: string,
  cacheKey: string,
  envVars?: Record<string, string>,
  overrides?: BuildOverrides,
): string[] {
  return ["build", repoPath, "--out", repoPath, "--cache-key", cacheKey, ...overrideArgs(overrides), ...envArgs(envVars)];
}

/** `nixpacks plan --format json`. */
export function nixpacksPlanArgs(
  repoPath: string,
  envVars?: Record<string, string>,
  overrides?: BuildOverrides,
): string[] {
  return ["plan", repoPath, "--format", "json", ...overrideArgs(overrides), ...envArgs(envVars)];
}

/** `docker build` for a repo Dockerfile. Every app env var is a build arg; VARDO_GIT_SHA unless the env sets it. */
export function dockerfileBuildArgs(opts: {
  imageName: string;
  dockerfile: string;
  context: string;
  loadArgs: string[];
  envVars: Record<string, string>;
  noCache?: boolean;
  buildKey?: string;
  gitSha?: string;
  labels?: Record<string, string>;
}): string[] {
  const args = ["build", ...opts.loadArgs, "--progress=plain", "-t", opts.imageName, "-f", opts.dockerfile];
  if (opts.noCache) args.push("--no-cache");
  if (opts.buildKey) args.push("--label", `${BUILD_KEY_LABEL}=${opts.buildKey}`);
  for (const [k, v] of Object.entries(opts.labels ?? {})) args.push("--label", `${k}=${v}`);
  for (const [k, v] of Object.entries(opts.envVars)) args.push("--build-arg", `${k}=${v}`);
  if (opts.gitSha && !(GIT_SHA_ARG in opts.envVars)) args.push("--build-arg", `${GIT_SHA_ARG}=${opts.gitSha}`);
  args.push(opts.context);
  return args;
}
