// Railpack CLI arguments. The cache key keeps each app's cache mounts (npm, .next/cache) out of other apps' builds.

export function railpackBuildArgs(
  imageName: string,
  repoPath: string,
  cacheKey: string,
  envVars?: Record<string, string>,
): string[] {
  const args = ["build", "--name", imageName, "--cache-key", cacheKey];
  if (envVars) {
    for (const [k, v] of Object.entries(envVars)) {
      args.push("--env", `${k}=${v}`);
    }
  }
  args.push(repoPath);
  return args;
}
