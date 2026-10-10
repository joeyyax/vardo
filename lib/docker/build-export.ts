// How a bounded build hands its image to the Docker daemon, chosen by the daemon's image store.

import { COMPOSE_QUERY_TIMEOUT } from "./constants";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

/** `containerd` when Docker keeps images in containerd, `classic` for overlay2 and other graph drivers. */
export type ImageStore = "containerd" | "classic" | "unknown";

/** Forces the plain `--load` export when set to `load`. */
export const EXPORT_ENV = "VARDO_BUILD_EXPORT";

const CONTAINERD_SNAPSHOTTER = "io.containerd.snapshotter.v1";

/** Reads `docker info --format '{{.Driver}}|{{json .DriverStatus}}'`. */
export function parseImageStore(stdout: string): ImageStore {
  const [driver = "", status = ""] = stdout.trim().split("|", 2);
  if (!driver) return "unknown";
  try {
    const pairs = JSON.parse(status || "null") as unknown;
    if (Array.isArray(pairs) && pairs.some((p) => Array.isArray(p) && p[0] === "driver-type" && p[1] === CONTAINERD_SNAPSHOTTER)) {
      return "containerd";
    }
  } catch {
    return "unknown";
  }
  return "classic";
}

/**
 * The docker exporter's options. The classic store unpacks and drops blobs, so uncompressed layers cost no disk;
 * the containerd store keeps blobs, so zstd, about as fast and smaller than gzip.
 */
export function exportOutput(store: ImageStore): string | null {
  if (store === "containerd") return "type=docker,compression=zstd";
  if (store === "classic") return "type=docker,compression=uncompressed";
  return null;
}

/** `docker build` flags that load the result into the daemon. */
export function exportArgs(store: ImageStore): string[] {
  const output = exportOutput(store);
  return output ? ["--output", output, "--provenance=false", "--sbom=false"] : ["--load"];
}

const TTL_MS = 10 * 60_000;
let cached: { at: number; value: ImageStore } | null = null;

/** The daemon's image store, read once per ten minutes. `unknown` when `docker info` fails. */
export async function detectImageStore(signal?: AbortSignal): Promise<ImageStore> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  let value: ImageStore = "unknown";
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["info", "--format", "{{.Driver}}|{{json .DriverStatus}}"],
      { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT, signal },
    );
    value = parseImageStore(String(stdout));
  } catch {
    // Unknown falls back to --load.
  }
  if (value !== "unknown") cached = { at: Date.now(), value };
  return value;
}

/** Image store to export for, or `unknown` when VARDO_BUILD_EXPORT=load. */
export async function exportStore(signal?: AbortSignal): Promise<ImageStore> {
  if (process.env[EXPORT_ENV] === "load") return "unknown";
  return detectImageStore(signal);
}

/** Clears the cached store. Tests only. */
export function resetImageStoreCache(): void {
  cached = null;
}
