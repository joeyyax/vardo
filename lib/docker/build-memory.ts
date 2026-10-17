// Runs builds in the vardo-buildkit container, whose memory limit bounds every build.

import { homedir } from "os";
import { join } from "path";
import { buildKitContainerName, DEFAULT_BUILDKIT_HOST, isBuildKitReachable } from "./buildkit";
import { COMPOSE_QUERY_TIMEOUT } from "./constants";
import { exportArgs, exportOutput, exportStore } from "./build-export";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { VARDO_HOME_DIR } from "@/lib/paths";

/** The buildx builder that points at the BuildKit container. */
export const BOUNDED_BUILDER = "vardo-bounded";

export type BoundedBuild = {
  /** Merged into the environment of `docker build` and `docker compose build`. */
  env: Record<string, string>;
  /** `docker build` leaves the result in the builder's cache unless told to load it. */
  loadArgs: string[];
  /** The docker exporter's options for bake's `*.output`; null loads with buildx's default. */
  output?: string | null;
  /** The container's memory limit in bytes, 0 when it has none, null when building on the daemon. */
  limitBytes: number | null;
  /** The BuildKit container, when builds run in one. */
  container?: string;
  /** Lines held back for the deploy log until the build runs on this server. */
  notes?: string[];
};

const UNBOUNDED: BoundedBuild = { env: {}, loadArgs: [], limitBytes: null };

/** Pinned buildx dir; registry auth swaps DOCKER_CONFIG for a throwaway directory. */
function buildxConfigDir(): string {
  return join(process.env.DOCKER_CONFIG ?? join(homedir(), ".docker"), "buildx");
}

/** Memory limit and memory+swap limit in bytes; 0 for none, swap null when unreadable. */
async function memoryLimits(container: string): Promise<{ memory: number; swap: number | null }> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["inspect", "-f", "{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}", container],
      { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT },
    );
    const [memory, swap] = stdout.trim().split(/\s+/).map(Number);
    return { memory: memory || 0, swap: Number.isFinite(swap) ? swap : null };
  } catch {
    return { memory: 0, swap: null };
  }
}

async function memoryLimit(container: string): Promise<number> {
  return (await memoryLimits(container)).memory;
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

/** BuildKit's memory limit, for naming it in a Railpack OOM error. */
export async function buildKitLimit(host: string): Promise<BoundedBuild> {
  const container = buildKitContainerName(host);
  if (!container) return UNBOUNDED;
  return { env: {}, loadArgs: [], limitBytes: await memoryLimit(container), container };
}

export function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(bytes % 1024 ** 3 === 0 ? 0 : 1)} GiB`;
}

/** Where this deploy's builds run. Without a log, its lines go to `notes`. */
export async function boundedBuild(log?: (line: string) => void, signal?: AbortSignal): Promise<BoundedBuild> {
  if (log) return localBuilder(log, signal);
  const notes: string[] = [];
  return { ...(await localBuilder((line) => notes.push(line), signal)), notes };
}

/** Falls back to the daemon when BuildKit is down or VARDO_BUILD_BUILDER=daemon. */
async function localBuilder(log: (line: string) => void, signal?: AbortSignal): Promise<BoundedBuild> {
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
  if (!(await ensureBuilder(host, dockerEnv(env)))) {
    log(`[build] Warning: could not register a builder for ${container} — building on the Docker daemon with no memory limit`);
    return UNBOUNDED;
  }

  const { memory: limitBytes, swap } = await memoryLimits(container);
  const store = await exportStore(signal);
  const output = exportOutput(store);
  if (output) log(`[build] Exporting ${output.includes("zstd") ? "zstd" : "uncompressed"} layers to the ${store} image store`);
  log(
    limitBytes > 0
      ? `[build] Building in ${container} (memory limit ${formatGiB(limitBytes)})`
      : `[build] Warning: building in ${container}, which has no memory limit — set VARDO_BUILDKIT_MEM and recreate it`,
  );
  // -1 is unlimited swap; a value above the limit is the limit plus that much swap.
  if (limitBytes > 0 && swap !== null && (swap < 0 || swap > limitBytes)) {
    log(
      `[build] Warning: ${container} can swap past its memory limit, so a build over the limit slows the whole host instead of failing. ` +
        "Run sudo vardo update to recreate it without swap.",
    );
  }
  return { env: { ...env, BUILDX_BUILDER: BOUNDED_BUILDER }, loadArgs: exportArgs(store), output, limitBytes, container };
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
    (build.limitBytes > 0
      ? `The build ran out of memory${limit}: it needed more than BuildKit's limit and was stopped rather than swap the host. `
      : "The build ran out of memory and was stopped before it could affect the host. ") +
      "Raise BuildKit's limit and recreate vardo-buildkit, or reduce the build's memory use:\n" +
      `  ${raiseBuildKitCommand(build.limitBytes)}\n` +
      message,
  );
}

/** Doubles the limit, at least 8 GiB. The redeploy recreates vardo-buildkit with it. */
export function raiseBuildKitCommand(limitBytes: number): string {
  const gib = Math.max(8, Math.ceil((limitBytes * 2) / 1024 ** 3));
  const env = join(VARDO_HOME_DIR, ".env");
  return `sudo sed -i 's/^VARDO_BUILDKIT_MEM=.*/VARDO_BUILDKIT_MEM=${gib}g/' ${env} && sudo vardo update`;
}
