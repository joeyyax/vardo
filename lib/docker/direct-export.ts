// Brings images a linked instance's BuildKit built straight to this host: pushed to the build registry, else exported here.

import { mkdtemp, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileAsync } from "@/lib/utils/exec";
import { formatBytes } from "@/lib/metrics/format";
import { REGISTRY_TRANSFER_TIMEOUT } from "./build-registry";
import { exportOutput, exportStore } from "./build-export";
import { BuilderError, builderFailureReason } from "./build-targets";
import type { BuildPlacementRecorder } from "./build-placement";
import { CUT_OFF, MIN_CEILING_BYTES, ceilingFor, largestLayer, lowerCeiling, type BroughtImage } from "./remote-build";

const TAG_TIMEOUT = 30_000;
/** Longest `docker load` of an exported image may run. */
const LOAD_TIMEOUT = 60 * 60_000;

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<unknown>;

/** Layer compression for a push: what the peer's image store would have pushed. */
export type PushCompression = "zstd" | "gzip";

/** Per target and image repo, the largest layer last brought here. Kept in memory. */
const lastLargest = new Map<string, number>();

export function resetDirectExport(): void {
  lastLargest.clear();
}

function repoKey(from: string, image: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return `${from}|${colon > slash ? image.slice(0, colon) : image}`;
}

/** BuildKit's output that pushes `ref` to the registry. */
export function registryOutput(ref: string, compression: PushCompression): string {
  return `type=image,name=${ref},push=true,compression=${compression}${compression === "zstd" ? ",oci-mediatypes=true" : ""}`;
}

function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  return `${typeof e?.message === "string" ? e.message : String(err)}\n${typeof e?.stderr === "string" ? e.stderr : ""}`;
}

/** The line of a failed build that names the push, else its first line. */
function pushLine(err: unknown, host: string): string {
  const lines = errorText(err).split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.includes(host) && /error|fail/i.test(l)) ?? lines.find((l) => /^error|ERROR/.test(l)) ?? lines[0] ?? "unknown error";
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr?.trim() || e?.message || String(err)).split("\n")[0];
}

function seconds(began: number): string {
  return `${((Date.now() - began) / 1000).toFixed(1)}s`;
}

type Mode = "registry" | "file" | "done";

/**
 * Runs `build` with one `--output` per image, then brings each here: a pushed ref is pulled, a docker tarball loaded.
 * A failed push or pull reruns the build to a tarball, which BuildKit's cache makes quick. Nothing is left on the target's daemon.
 */
export async function bringDirect(
  images: BroughtImage[],
  opts: {
    /** Registry auth env for this host's docker CLI; the build's buildx reads the same. */
    authEnv: NodeJS.ProcessEnv;
    from: string;
    log: (line: string) => void;
    compression: PushCompression;
    build: (outputs: string[]) => Promise<void>;
    placement?: Pick<BuildPlacementRecorder, "transferred">;
    signal?: AbortSignal;
    exec?: Exec;
    /** The docker exporter's options for this host's image store; read from it when unset. */
    fileOutput?: string;
  },
): Promise<void> {
  const exec = opts.exec ?? (execFileAsync as unknown as Exec);
  const here = opts.authEnv;
  const { from, log } = opts;
  const dir = await mkdtemp(join(tmpdir(), "vardo-export-"));
  const tar = (i: number) => join(dir, `${i}.tar`);
  const fileOutput = opts.fileOutput ?? exportOutput(await exportStore(opts.signal)) ?? "type=docker";

  const skipped = images.map(() => false);
  const mode: Mode[] = images.map(({ image, ref }, i) => {
    if (!ref) return "file";
    const ceiling = ceilingFor(from);
    const largest = lastLargest.get(repoKey(from, image));
    if (ceiling !== null && largest !== undefined && largest >= ceiling) {
      skipped[i] = true;
      log(`[build] Skipping the build registry for ${image}: its ${formatBytes(largest)} layer is at least the ${formatBytes(ceiling)} one cut off pushing from ${from}`);
      return "file";
    }
    return "registry";
  });
  const tried = mode.map((m) => m === "registry");
  const outputs = () =>
    images.map(({ ref }, i) => (mode[i] === "registry" ? registryOutput(ref!, opts.compression) : mode[i] === "file" ? `${fileOutput},dest=${tar(i)}` : "type=cacheonly"));
  let cutOff = false;

  try {
    for (let attempt = 0; ; attempt++) {
      const began = Date.now();
      try {
        await opts.build(outputs());
      } catch (err) {
        const pushed = images.filter((_, i) => mode[i] === "registry");
        const host = pushed.map((p) => p.ref!.split("/")[0]).find((h) => errorText(err).includes(h));
        if (attempt > 0 || opts.signal?.aborted || !host) throw err;
        cutOff = CUT_OFF.test(errorText(err));
        log(`[build] Couldn't use the build registry: couldn't push ${pushed[0].ref} from the target: ${pushLine(err, host)}`);
        mode.forEach((m, i) => void (m === "registry" && (mode[i] = "file")));
        continue;
      }

      let retry = false;
      for (const [i, { image, ref }] of images.entries()) {
        if (mode[i] === "registry") {
          const pulled = Date.now();
          try {
            await exec("docker", ["pull", "--quiet", ref!], { env: here, timeout: REGISTRY_TRANSFER_TIMEOUT, signal: opts.signal });
            await exec("docker", ["tag", ref!, image], { env: here, timeout: TAG_TIMEOUT });
            log(`[build] Pulled ${ref} from the build registry as ${image} (${seconds(pulled)})`);
            opts.placement?.transferred({ via: "registry", ms: Date.now() - pulled });
            mode[i] = "done";
          } catch (err) {
            if (opts.signal?.aborted) throw err;
            log(`[build] Couldn't use the build registry: couldn't pull ${ref} here: ${firstLine(err)}`);
            mode[i] = "file";
            retry = true;
          } finally {
            await exec("docker", ["image", "rm", ref!], { env: here, timeout: TAG_TIMEOUT }).catch(() => {});
          }
        } else if (mode[i] === "file") {
          log(`[build] ${ref && tried[i] ? "Registry unavailable; copying" : "Copying"} ${image} from ${from} over SSH`);
          try {
            const bytes = (await stat(tar(i))).size;
            await exec("docker", ["load", "--quiet", "-i", tar(i)], { env: here, timeout: LOAD_TIMEOUT, signal: opts.signal });
            log(`[build] Copied ${image} from ${from} over SSH (${formatBytes(bytes)}, ${seconds(began)})`);
            opts.placement?.transferred({ via: skipped[i] ? "registry_skipped" : "ssh", ms: Date.now() - began, bytes });
            mode[i] = "done";
          } catch (err) {
            if (opts.signal?.aborted) throw err;
            const message = firstLine(err);
            const reason = builderFailureReason(message);
            if (reason) log(`[build] Copying over SSH failed: ${message}`);
            throw new BuilderError(`couldn't copy ${image} here over SSH: ${reason ?? message}`, err);
          } finally {
            await rm(tar(i), { force: true }).catch(() => {});
          }
        }
      }
      if (!retry || attempt > 0) break;
    }

    const sizes = await Promise.all(images.map(({ image }) => largestLayer(image, exec, here)));
    images.forEach(({ image }, i) => {
      if (sizes[i] !== null) lastLargest.set(repoKey(from, image), sizes[i]!);
    });
    // Only this size and up skips the registry; smaller images keep trying it.
    const biggest = Math.max(0, ...sizes.filter((s, i): s is number => s !== null && tried[i]));
    if (cutOff && biggest >= MIN_CEILING_BYTES) lowerCeiling(from, biggest);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
