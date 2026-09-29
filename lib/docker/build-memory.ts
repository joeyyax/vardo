// ---------------------------------------------------------------------------
// Memory-bounded builds
//
// A build on the Docker daemon runs under no memory limit, so one large build
// can take the whole host down. Builds run in the vardo-buildkit container
// instead, whose memory limit bounds every build at once.
// ---------------------------------------------------------------------------

import { homedir } from "os";
import { join } from "path";
import { buildKitContainerName, DEFAULT_BUILDKIT_HOST, isBuildKitReachable } from "./buildkit";
import { COMPOSE_QUERY_TIMEOUT } from "./constants";
import { execFileAsync } from "@/lib/utils/exec";

/** The buildx builder that points at the BuildKit container. */
export const BOUNDED_BUILDER = "vardo-bounded";

export type BoundedBuild = {
  /** Merged into the environment of `docker build` and `docker compose build`. */
  env: Record<string, string>;
  /** `docker build` leaves the result in the builder's cache unless told to load it. */
  loadArgs: string[];
  /** The container's memory limit in bytes, 0 when it has none, null when building on the daemon. */
  limitBytes: number | null;
};

const UNBOUNDED: BoundedBuild = { env: {}, loadArgs: [], limitBytes: null };

/**
 * Buildx keeps builders under DOCKER_CONFIG, and registry auth swaps that for a
 * throwaway directory. Pinned here so the builder is found either way.
 */
function buildxConfigDir(): string {
  return join(process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"), "buildx");
}

async function memoryLimit(container: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "-f", "{{.HostConfig.Memory}}", container],
      { timeout: COMPOSE_QUERY_TIMEOUT },
    );
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function ensureBuilder(host: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const inspect = () =>
    execFileAsync("docker", ["buildx", "inspect", BOUNDED_BUILDER], { env, timeout: COMPOSE_QUERY_TIMEOUT }).then(
      () => true,
      () => false,
    );
  if (await inspect()) return true;
  try {
    await execFileAsync(
      "docker",
      ["buildx", "create", "--name", BOUNDED_BUILDER, "--driver", "remote", host],
      { env, timeout: COMPOSE_QUERY_TIMEOUT },
    );
    return true;
  } catch {
    // A concurrent deploy may have created it first.
    return inspect();
  }
}

/** Railpack builds in BuildKit directly; this is only for naming its limit in an OOM error. */
export async function buildKitLimit(host: string): Promise<BoundedBuild> {
  const container = buildKitContainerName(host);
  if (!container) return UNBOUNDED;
  return { env: {}, loadArgs: [], limitBytes: await memoryLimit(container) };
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GiB`;
}

/**
 * Where this deploy's builds should run. Falls back to the daemon, with a
 * warning, when the BuildKit container is not running or has been opted out
 * with VARDO_BUILD_BUILDER=daemon.
 */
export async function boundedBuild(log: (line: string) => void, signal?: AbortSignal): Promise<BoundedBuild> {
  if (process.env.VARDO_BUILD_BUILDER === "daemon") {
    log("[build] Warning: VARDO_BUILD_BUILDER=daemon — this build runs on the Docker daemon with no memory limit");
    return UNBOUNDED;
  }

  const host = process.env.BUILDKIT_HOST || DEFAULT_BUILDKIT_HOST;
  const container = buildKitContainerName(host);
  if (!container || !(await isBuildKitReachable(host, signal))) {
    log(
      "[build] Warning: no BuildKit container is running, so this build runs on the Docker daemon with no memory limit. " +
        'Add "buildkit" to COMPOSE_PROFILES to bound builds.',
    );
    return UNBOUNDED;
  }

  const env = { BUILDX_CONFIG: buildxConfigDir() };
  if (!(await ensureBuilder(host, { ...process.env, ...env }))) {
    log(`[build] Warning: could not register a builder for ${container} — building on the Docker daemon with no memory limit`);
    return UNBOUNDED;
  }

  const limitBytes = await memoryLimit(container);
  log(
    limitBytes > 0
      ? `[build] Building in ${container} (memory limit ${formatGiB(limitBytes)})`
      : `[build] Warning: building in ${container}, which has no memory limit — set VARDO_BUILDKIT_MEM and recreate it`,
  );
  return { env: { ...env, BUILDX_BUILDER: BOUNDED_BUILDER }, loadArgs: ["--load"], limitBytes };
}

/** What BuildKit and the kernel report when a build step runs out of memory. */
const OOM_PATTERNS = [/cannot allocate memory/i, /ResourceExhausted/, /exit code: 137/i, /signal: killed/i, /\bOOM\b/];

export function isBuildOom(message: string): boolean {
  return OOM_PATTERNS.some((p) => p.test(message));
}

/** Rewrites a build failure that ran out of memory into one that says so. Other errors pass through. */
export function explainBuildOom(err: unknown, build: BoundedBuild): unknown {
  const message = err instanceof Error ? err.message : String(err);
  if (build.limitBytes === null || !isBuildOom(message)) return err;
  const limit = build.limitBytes > 0 ? ` (${formatGiB(build.limitBytes)})` : "";
  return new Error(
    `The build ran out of memory${limit} and was stopped before it could affect the host. ` +
      "Raise VARDO_BUILDKIT_MEM and recreate vardo-buildkit, or reduce the build's memory use.\n" +
      message,
  );
}
