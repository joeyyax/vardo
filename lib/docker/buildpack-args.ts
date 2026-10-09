// Railpack 0.35 and Nixpacks 1.41 CLI arguments. Both take --build-cmd and --start-cmd on build and plan.

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
): string[] {
  return ["build", "--name", imageName, "--cache-key", cacheKey, ...overrideArgs(overrides), ...envArgs(envVars), repoPath];
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
): string[] {
  return ["build", repoPath, "--name", imageName, ...overrideArgs(overrides), ...envArgs(envVars)];
}

/** `nixpacks plan --format json`. */
export function nixpacksPlanArgs(
  repoPath: string,
  envVars?: Record<string, string>,
  overrides?: BuildOverrides,
): string[] {
  return ["plan", repoPath, "--format", "json", ...overrideArgs(overrides), ...envArgs(envVars)];
}
