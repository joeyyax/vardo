// Where a build on a target runs: a linked instance's vardo-buildkit when it has one, else the target's daemon.

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileAsync } from "@/lib/utils/exec";
import { buildKitContainerName, DEFAULT_BUILDKIT_HOST } from "./buildkit";
import { EXPORT_ENV, exportArgs, exportOutput, parseImageStore, type ImageStore } from "./build-export";
import { formatGiB, type BoundedBuild } from "./build-memory";
import type { BuildTarget } from "./build-targets";
import { COMPOSE_QUERY_TIMEOUT } from "./constants";
import { TARGET_BUILD } from "./remote-build";
import type { PushCompression } from "./direct-export";

/** The buildx builder registered per session against the peer's BuildKit. */
export const TARGET_BUILDER = "vardo-target";

const BOOTSTRAP_TIMEOUT = 60_000;

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;

function firstLine(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  return (String(e?.stderr ?? "").trim() || e?.message || String(err)).split("\n")[0];
}

/** A target's builder. `compression` is set when it's the peer's BuildKit, which then exports straight here. */
export type TargetBuilder = { build: BoundedBuild; close: () => Promise<void>; compression: PushCompression | null };

/**
 * The builder for a build on `target`, whose daemon `there` reaches. A mesh target's runs in its vardo-buildkit
 * under a session-private buildx config; anything else, or a peer without one, builds on the daemon.
 */
export async function targetBuilder(
  target: Pick<BuildTarget, "kind" | "name">,
  there: NodeJS.ProcessEnv,
  log: (line: string) => void,
  { exec = execFileAsync as unknown as Exec, signal }: { exec?: Exec; signal?: AbortSignal } = {},
): Promise<TargetBuilder> {
  const daemon: TargetBuilder = { build: TARGET_BUILD, close: async () => {}, compression: null };
  if (target.kind !== "mesh") return daemon;

  const container = buildKitContainerName(DEFAULT_BUILDKIT_HOST)!;
  const run = (args: string[], env: NodeJS.ProcessEnv = there, timeout = COMPOSE_QUERY_TIMEOUT) =>
    exec("docker", args, { env, timeout, signal });

  const state = await run(["inspect", "-f", "{{.State.Running}} {{.HostConfig.Memory}}", container]).then(
    ({ stdout }) => String(stdout).trim().split(/\s+/),
    () => [] as string[],
  );
  if (state[0] !== "true") {
    log(`[build] ${target.name} has no running ${container}, so this build runs on its Docker daemon with no memory limit`);
    return daemon;
  }

  const dir = await mkdtemp(join(tmpdir(), "vardo-buildx-"));
  const close = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await run(
      ["buildx", "create", "--name", TARGET_BUILDER, "--driver", "remote", "--bootstrap", DEFAULT_BUILDKIT_HOST],
      { ...there, BUILDX_CONFIG: dir },
      BOOTSTRAP_TIMEOUT,
    );
  } catch (err) {
    await close();
    if (signal?.aborted) throw err;
    log(`[build] Couldn't reach ${target.name}'s ${container} (${firstLine(err)}), so this build runs on its Docker daemon with no memory limit`);
    return daemon;
  }

  const store: ImageStore = process.env[EXPORT_ENV] === "load"
    ? "unknown"
    : await run(["info", "--format", "{{.Driver}}|{{json .DriverStatus}}"]).then(({ stdout }) => parseImageStore(String(stdout)), () => "unknown" as const);
  const limitBytes = Number(state[1]) || 0;
  log(
    limitBytes > 0
      ? `[build] Building in ${target.name}'s ${container} (memory limit ${formatGiB(limitBytes)})`
      : `[build] Warning: building in ${target.name}'s ${container}, which has no memory limit`,
  );
  return {
    build: { env: { BUILDX_CONFIG: dir, BUILDX_BUILDER: TARGET_BUILDER }, loadArgs: exportArgs(store), output: exportOutput(store), limitBytes },
    close,
    compression: store === "containerd" ? "zstd" : "gzip",
  };
}

/** Runs `run` with the target's builder and removes its config after. */
export async function withTargetBuilder<T>(
  target: Pick<BuildTarget, "kind" | "name">,
  there: NodeJS.ProcessEnv,
  log: (line: string) => void,
  run: (builder: Omit<TargetBuilder, "close">) => Promise<T>,
  opts: { exec?: Exec; signal?: AbortSignal } = {},
): Promise<T> {
  const builder = await targetBuilder(target, there, log, opts);
  try {
    return await run(builder);
  } finally {
    await builder.close();
  }
}
