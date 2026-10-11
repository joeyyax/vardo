// Identity of a repo build: equal keys build the same image, so a deploy can reuse the earlier one.

import { createHash } from "crypto";

/** Bump when Vardo changes how it builds (flags, context, args), so no earlier image matches. */
export const BUILD_CONFIG_VERSION = 2;

/** Label carrying the key on Dockerfile builds. */
export const BUILD_KEY_LABEL = "vardo.build.key";

/** Build arg carrying the deployed commit, for builds that would otherwise read .git. */
export const GIT_SHA_ARG = "VARDO_GIT_SHA";

/** How a deploy treats an earlier image: reuse it, rebuild with the layer cache, or rebuild without it. */
export type RebuildMode = "force" | "no-cache";

/** The app's standing choice: reuse and cache, skip image reuse only, or skip both. */
export const BUILD_CACHE_MODES = ["use", "skip-reuse", "never"] as const;
export type BuildCacheMode = (typeof BUILD_CACHE_MODES)[number];

const BUILD_CACHE_REBUILD: Record<BuildCacheMode, RebuildMode | undefined> = {
  use: undefined,
  "skip-reuse": "force",
  never: "no-cache",
};

/** A deploy asked for a rebuild wins; otherwise the app's setting applies. Rollbacks keep the earlier build. */
export function resolveRebuild(
  requested: RebuildMode | undefined,
  setting: BuildCacheMode | null | undefined,
  isRollback = false,
): RebuildMode | undefined {
  if (requested) return requested;
  if (isRollback) return undefined;
  return BUILD_CACHE_REBUILD[setting ?? "use"];
}

/** The deploy log line for a mode, or null when nothing special applies. */
export function buildCacheLogLine(rebuild: RebuildMode | undefined, setting: BuildCacheMode | null | undefined, requested: RebuildMode | undefined): string | null {
  if (!rebuild) return null;
  const source = requested ? "this deploy asked for it" : "the app's Build cache setting";
  const what = rebuild === "no-cache" ? "Never use cache: rebuilding without image reuse or the layer cache" : "Skip image reuse: rebuilding with the layer cache";
  return `[deploy] Build cache: ${what} (${source})`;
}

export type BuildKeyInput = {
  appId: string;
  gitSha: string;
  /** Root directory inside the repo; empty for the repo root. */
  rootDirectory: string;
  engine: "dockerfile" | "railpack" | "nixpacks";
  engineVersion: string;
  /** Dockerfile path for Dockerfile builds. */
  dockerfilePath: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  /** Every build arg (Dockerfile) or --env (Railpack, Nixpacks) the build is given. */
  buildArgs: Record<string, string>;
  /** The build context includes .git. */
  withGitDir: boolean;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Hash of the args only, so the key never carries a value. */
export function buildArgsHash(args: Record<string, string>): string {
  return sha256(JSON.stringify(Object.keys(args).sort().map((k) => [k, args[k]])));
}

export function buildKey(input: BuildKeyInput): string {
  return sha256(
    JSON.stringify([
      BUILD_CONFIG_VERSION,
      input.appId,
      input.gitSha,
      input.rootDirectory.replace(/^\.?\/+|\/+$/g, ""),
      input.engine,
      input.engineVersion,
      input.engine === "dockerfile" ? input.dockerfilePath || "Dockerfile" : null,
      input.buildCommand?.trim() || null,
      input.startCommand?.trim() || null,
      buildArgsHash(input.buildArgs),
      input.withGitDir,
    ]),
  );
}

export type ReuseCandidate = { id: string; image: string };

/** The newest earlier deploy whose image is still on the host. */
export async function findReusableImage(
  candidates: ReuseCandidate[],
  imageExists: (image: string) => Promise<boolean>,
): Promise<ReuseCandidate | null> {
  for (const c of candidates) {
    if (await imageExists(c.image)) return c;
  }
  return null;
}
