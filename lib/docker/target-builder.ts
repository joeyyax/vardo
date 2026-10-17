// Where a build on a target runs: a linked instance's isolated builder, else the target's daemon.

import { execFileAsync } from "@/lib/utils/exec";
import { exportOutput, exportStore, type ImageStore } from "./build-export";
import type { BoundedBuild } from "./build-memory";
import { BuilderError, type BuildTarget } from "./build-targets";
import { TARGET_BUILD } from "./remote-build";
import type { PushCompression } from "./direct-export";
import { openMeshBuilder, TARGET_BUILDER } from "./mesh-builder";

export { TARGET_BUILDER };

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;

function firstLine(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string };
  return (String(e?.stderr ?? "").trim() || e?.message || String(err)).split("\n")[0];
}

/**
 * A target's builder. `compression` is set when it's the peer's BuildKit, which then exports straight here.
 * `channel` is how a docker tarball comes back: over SSH, or over the BuildKit session from an isolated builder.
 */
export type TargetBuilder = { build: BoundedBuild; close: () => Promise<void>; compression: PushCompression | null; channel: "ssh" | "session" };

/**
 * The builder for a build on `target`, whose daemon `there` reaches. A mesh target's runs in the peer's isolated builder
 * under a session-private buildx config, and throws without one; anything else builds on the daemon.
 */
export async function targetBuilder(
  target: Pick<BuildTarget, "kind" | "name" | "builder">,
  there: NodeJS.ProcessEnv,
  log: (line: string) => void,
  { exec = execFileAsync as unknown as Exec, signal, localStore = exportStore }: { exec?: Exec; signal?: AbortSignal; localStore?: (signal?: AbortSignal) => Promise<ImageStore> } = {},
): Promise<TargetBuilder> {
  if (target.kind !== "mesh") return { build: TARGET_BUILD, close: async () => {}, compression: null, channel: "ssh" };
  if (!target.builder) throw new BuilderError(`${target.name} has no isolated builder for this instance`);
  const session = await openMeshBuilder(target.builder, { exec, signal, env: there }).catch((err) => {
    if (signal?.aborted) throw err;
    throw new BuilderError(`couldn't reach ${target.name}'s isolated builder: ${firstLine(err)}`, err);
  });
  // Images come back here, so this host's image store picks the format.
  const store = await localStore(signal).catch(() => "unknown" as const);
  log(`[build] Building in ${target.name}'s isolated builder over the mesh`);
  return {
    build: { env: session.env, loadArgs: [], output: exportOutput(store), limitBytes: 0 },
    close: session.close,
    compression: store === "containerd" ? "zstd" : "gzip",
    channel: "session",
  };
}

/** Runs `run` with the target's builder and removes its config after. */
export async function withTargetBuilder<T>(
  target: Pick<BuildTarget, "kind" | "name" | "builder">,
  there: NodeJS.ProcessEnv,
  log: (line: string) => void,
  run: (builder: Omit<TargetBuilder, "close">) => Promise<T>,
  opts: { exec?: Exec; signal?: AbortSignal; localStore?: (signal?: AbortSignal) => Promise<ImageStore> } = {},
): Promise<T> {
  const builder = await targetBuilder(target, there, log, opts);
  try {
    return await run(builder);
  } finally {
    await builder.close();
  }
}
