// Brings an image built on a target to this host: through the build registry, else over the SSH session.

import { spawn as nodeSpawn, type ChildProcess } from "child_process";
import { execFileAsync } from "@/lib/utils/exec";
import { formatBytes } from "@/lib/metrics/format";
import { REGISTRY_TRANSFER_TIMEOUT } from "./build-registry";
import { BuilderError, builderFailureReason, remoteEnv, type DockerSession } from "./build-targets";
import type { BoundedBuild } from "./build-memory";
import type { BuildPlacementRecorder } from "./build-placement";

const TAG_TIMEOUT = 30_000;
/** A copy over SSH fails when no bytes move for this long. */
export const COPY_IDLE_TIMEOUT = 120_000;
/** A copy over SSH fails after this long in all. */
export const COPY_TIMEOUT = 60 * 60_000;
const KILL_GRACE_MS = 5_000;
const STDERR_MAX = 8_192;

/** A target builds on its own daemon, loaded into its image store, with no memory bound from here. */
export const TARGET_BUILD: BoundedBuild = { env: {}, loadArgs: [], limitBytes: null };

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<unknown>;
type Spawn = (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: ("ignore" | "pipe")[]; detached: boolean }) => ChildProcess;

/** Layers smaller than this never set a target's push ceiling. */
export const MIN_CEILING_BYTES = 64 * 1024 ** 2;
/** How long a learned push ceiling holds. */
export const CEILING_TTL_MS = 7 * 24 * 60 * 60_000;
/** How a push cut off mid-upload reads, as opposed to one the registry refused. */
export const CUT_OFF = /EOF|broken pipe|connection reset|closed|timed? ?out|deadline|\b408\b/i;

/** Per target, the largest uncompressed layer whose push was cut off. Kept in memory; a restart relearns it. */
const pushCeilings = new Map<string, { bytes: number; at: number }>();

export function resetPushCeilings(): void {
  pushCeilings.clear();
}

export function ceilingFor(target: string, now = Date.now()): number | null {
  const c = pushCeilings.get(target);
  if (!c) return null;
  if (now - c.at > CEILING_TTL_MS) {
    pushCeilings.delete(target);
    return null;
  }
  return c.bytes;
}

/** Lowers a target's push ceiling to `bytes`, or sets it. */
export function lowerCeiling(target: string, bytes: number): void {
  const ceiling = ceilingFor(target);
  pushCeilings.set(target, { bytes: Math.min(bytes, ceiling ?? bytes), at: Date.now() });
}

/** The image's largest uncompressed layer on the daemon `there` reaches, or null when docker can't say. */
export async function largestLayer(image: string, exec: Exec, there: NodeJS.ProcessEnv): Promise<number | null> {
  try {
    const { stdout } = (await exec("docker", ["history", "--no-trunc", "--human=false", "--format", "{{.Size}}", image], { env: there, timeout: TAG_TIMEOUT })) as { stdout: string };
    const sizes = String(stdout).split("\n").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    return sizes.length > 0 ? Math.max(...sizes) : null;
  } catch {
    return null;
  }
}

/** An image on the target, and its build registry ref when it has one. */
export type BroughtImage = { image: string; ref: string | null };

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr?.trim() || e?.message || String(err)).split("\n")[0];
}

function errorText(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return `${e?.message ?? String(err)}\n${e?.stderr ?? ""}`;
}

class PushError extends Error {
  constructor(message: string, readonly cutOff: boolean, cause: unknown) {
    super(message, { cause });
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Pushes from the target and pulls here under the image's own name. The image stays on the target. */
async function viaRegistry(image: string, ref: string, exec: Exec, there: NodeJS.ProcessEnv, here: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  try {
    await exec("docker", ["tag", image, ref], { env: there, timeout: TAG_TIMEOUT, signal });
    await exec("docker", ["push", "--quiet", ref], { env: there, timeout: REGISTRY_TRANSFER_TIMEOUT, signal });
  } catch (err) {
    throw new PushError(`couldn't push ${ref} from the target: ${firstLine(err)}`, CUT_OFF.test(errorText(err)), err);
  } finally {
    await exec("docker", ["image", "rm", ref], { env: there, timeout: TAG_TIMEOUT }).catch(() => {});
  }
  try {
    await exec("docker", ["pull", "--quiet", ref], { env: here, timeout: REGISTRY_TRANSFER_TIMEOUT, signal });
    await exec("docker", ["tag", ref, image], { env: here, timeout: TAG_TIMEOUT });
  } catch (err) {
    throw new Error(`couldn't pull ${ref} here: ${firstLine(err)}`, { cause: err });
  } finally {
    await exec("docker", ["image", "rm", ref], { env: here, timeout: TAG_TIMEOUT }).catch(() => {});
  }
}

/** Streams `docker save` on one daemon into `docker load` on another; returns the bytes sent. Either end failing kills the other. */
export function copyImage(
  image: string,
  opts: {
    fromEnv: NodeJS.ProcessEnv;
    toEnv: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    spawn?: Spawn;
    idleMs?: number;
    timeoutMs?: number;
  },
): Promise<number> {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn);
  const idleMs = opts.idleMs ?? COPY_IDLE_TIMEOUT;
  const timeoutMs = opts.timeoutMs ?? COPY_TIMEOUT;
  if (opts.signal?.aborted) return Promise.reject(new Error("Deployment aborted"));

  return new Promise((resolve, reject) => {
    const save = spawn("docker", ["save", image], { env: opts.fromEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const load = spawn("docker", ["load", "--quiet"], { env: opts.toEnv, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const ends = [
      { name: "docker save on the target", proc: save, stderr: "", done: false },
      { name: "docker load here", proc: load, stderr: "", done: false },
    ];
    let bytes = 0;
    let failure: string | null = null;

    const kill = (proc: ChildProcess) => {
      if (proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null) return;
      const pid = proc.pid;
      const signalGroup = (sig: NodeJS.Signals) => {
        try { process.kill(-pid, sig); } catch { try { proc.kill(sig); } catch { /* exited */ } }
      };
      signalGroup("SIGTERM");
      const force = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
      force.unref?.();
    };
    const fail = (reason: string) => {
      if (failure) return;
      failure = reason;
      for (const end of ends) if (!end.done) kill(end.proc);
    };
    const onAbort = () => fail("Deployment aborted");
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let idle: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => fail(`no data for ${idleMs / 1000}s`), idleMs);
    };
    resetIdle();
    const deadline = setTimeout(() => fail(`timed out after ${timeoutMs / 1000}s`), timeoutMs);

    for (const end of ends) {
      end.proc.stderr?.on("data", (chunk: Buffer) => {
        end.stderr = (end.stderr + chunk.toString()).slice(-STDERR_MAX);
      });
      end.proc.on("error", (err) => fail(`${end.name} couldn't start: ${err.message}`));
      end.proc.on("close", (code) => {
        end.done = true;
        if (end.proc === save && idle) clearTimeout(idle);
        if (code !== 0) fail(`${end.name} failed${code === null ? "" : ` (exit ${code})`}: ${end.stderr.trim().split("\n").at(-1) || "no output"}`);
        if (!ends.every((e) => e.done)) return;
        if (idle) clearTimeout(idle);
        clearTimeout(deadline);
        opts.signal?.removeEventListener("abort", onAbort);
        if (failure) reject(new Error(failure));
        else resolve(bytes);
      });
    }

    save.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (!ends[0].done) resetIdle();
    });
    // Load exiting early closes its stdin; its own exit reports why.
    load.stdin?.on("error", () => {});
    if (save.stdout && load.stdin) save.stdout.pipe(load.stdin);
    load.stdout?.resume();
  });
}

/**
 * Brings each image here from the target: through the build registry when it has a ref, else over the SSH session.
 * A registry failure falls back to SSH; only both failing is the builder's. The images leave the target either way.
 */
export async function bringBack(
  images: BroughtImage[],
  opts: {
    /** Registry auth env for this host's docker CLI. */
    authEnv: NodeJS.ProcessEnv;
    session: DockerSession;
    /** The target's name for the deploy log. */
    from: string;
    log: (line: string) => void;
    /** Records how each image came back, as the log reports it. */
    placement?: Pick<BuildPlacementRecorder, "transferred">;
    signal?: AbortSignal;
    exec?: Exec;
    spawn?: Spawn;
  },
): Promise<void> {
  const exec = opts.exec ?? (execFileAsync as unknown as Exec);
  const there = remoteEnv(opts.authEnv, opts.session);
  const here = opts.authEnv;
  let registryDown = false;
  try {
    for (const { image, ref } of images) {
      let skipped = false;
      if (ref && !registryDown) {
        const largest = await largestLayer(image, exec, there);
        const ceiling = ceilingFor(opts.from);
        if (largest !== null && ceiling !== null && largest >= ceiling) {
          skipped = true;
          opts.log(`[build] Skipping the build registry for ${image}: its ${formatBytes(largest)} layer is at least the ${formatBytes(ceiling)} one cut off pushing from ${opts.from}`);
        } else {
          const began = Date.now();
          try {
            await viaRegistry(image, ref, exec, there, here, opts.signal);
            const ms = Date.now() - began;
            opts.log(`[build] Pulled ${ref} from the build registry as ${image} (${seconds(ms)})`);
            opts.placement?.transferred({ via: "registry", ms });
            continue;
          } catch (err) {
            if (opts.signal?.aborted) throw err;
            if (err instanceof PushError && err.cutOff && largest !== null && largest >= MIN_CEILING_BYTES) {
              // Only this size and up skips the registry; smaller images keep trying it.
              pushCeilings.set(opts.from, { bytes: Math.min(largest, ceiling ?? largest), at: Date.now() });
            } else {
              registryDown = true;
            }
            opts.log(`[build] Couldn't use the build registry: ${(err as Error).message}`);
          }
        }
      }
      opts.log(`[build] ${ref && !skipped ? "Registry unavailable; copying" : "Copying"} ${image} from ${opts.from} over SSH`);
      const began = Date.now();
      try {
        const bytes = await copyImage(image, { fromEnv: there, toEnv: here, signal: opts.signal, spawn: opts.spawn });
        const ms = Date.now() - began;
        opts.log(`[build] Copied ${image} from ${opts.from} over SSH (${formatBytes(bytes)}, ${seconds(ms)})`);
        opts.placement?.transferred({ via: skipped ? "registry_skipped" : "ssh", ms, bytes });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        const message = (err as Error).message;
        const reason = builderFailureReason(message);
        if (reason) opts.log(`[build] Copying over SSH failed: ${message}`);
        throw new BuilderError(`couldn't copy ${image} here over SSH: ${reason ?? message}`, err);
      }
    }
  } finally {
    const all = images.map((i) => i.image);
    if (all.length > 0) await exec("docker", ["image", "rm", ...all], { env: there, timeout: TAG_TIMEOUT }).catch(() => {});
  }
}
