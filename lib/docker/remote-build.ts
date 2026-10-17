// Brings an image built on a target to this host through the build registry.

import { execFileAsync } from "@/lib/utils/exec";
import { REGISTRY_TRANSFER_TIMEOUT } from "./build-registry";
import { BuilderError, remoteEnv, type DockerSession } from "./build-targets";
import type { BoundedBuild } from "./build-memory";

const TAG_TIMEOUT = 30_000;

/** A target builds on its own daemon, loaded into its image store, with no memory bound from here. */
export const TARGET_BUILD: BoundedBuild = { env: {}, loadArgs: [], limitBytes: null };

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<unknown>;

export type BroughtImage = { image: string; ref: string };

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr?.trim() || e?.message || String(err)).split("\n")[0];
}

/** Pushes each image from the target to the registry and pulls it here under its own name. Any failure is the builder's. */
export async function bringBack(
  images: BroughtImage[],
  opts: {
    /** Registry auth env for this host's docker CLI. */
    authEnv: NodeJS.ProcessEnv;
    session: DockerSession;
    log: (line: string) => void;
    signal?: AbortSignal;
    exec?: Exec;
  },
): Promise<void> {
  const exec = opts.exec ?? (execFileAsync as unknown as Exec);
  const there = remoteEnv(opts.authEnv, opts.session);
  const here = opts.authEnv;
  for (const { image, ref } of images) {
    const began = Date.now();
    try {
      await exec("docker", ["tag", image, ref], { env: there, timeout: TAG_TIMEOUT, signal: opts.signal });
      await exec("docker", ["push", "--quiet", ref], { env: there, timeout: REGISTRY_TRANSFER_TIMEOUT, signal: opts.signal });
    } catch (err) {
      throw new BuilderError(`couldn't push ${ref} from it: ${firstLine(err)}`, err);
    } finally {
      await exec("docker", ["image", "rm", ref, image], { env: there, timeout: TAG_TIMEOUT }).catch(() => {});
    }
    try {
      await exec("docker", ["pull", "--quiet", ref], { env: here, timeout: REGISTRY_TRANSFER_TIMEOUT, signal: opts.signal });
      await exec("docker", ["tag", ref, image], { env: here, timeout: TAG_TIMEOUT });
    } catch (err) {
      throw new BuilderError(`couldn't pull ${ref} here: ${firstLine(err)}`, err);
    } finally {
      await exec("docker", ["image", "rm", ref], { env: here, timeout: TAG_TIMEOUT }).catch(() => {});
    }
    opts.log(`[build] Pulled ${ref} from the build registry as ${image} (${((Date.now() - began) / 1000).toFixed(1)}s)`);
  }
}
