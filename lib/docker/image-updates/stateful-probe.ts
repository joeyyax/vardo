// Probes a running service for a mounted data directory and its stamp. Verdicts are cached per image digest.

import { createHash } from "node:crypto";
import { redis } from "@/lib/redis";
import { logger } from "@/lib/logger";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { inspectContainer, inspectImageMeta, listContainers } from "@/lib/docker/client";
import { DATA_STAMPS, coveredDataPath, detectStateful, type StatefulVerdict } from "./stateful-detect";
import { appImages, type UpdatableApp } from "./compose-images";

const log = logger.child("image-stateful");

const DIGEST_PREFIX = "image-updates:stateful:digest:";
const SERVICE_PREFIX = "image-updates:stateful:service:";
/** Thirty days. */
const TTL_SECONDS = 30 * 24 * 60 * 60;
const EXEC_TIMEOUT_MS = 5_000;
/** An app with nothing running is retried after this long. */
const RETRY_UNKNOWN_MS = 6 * 60 * 60 * 1000;
const attempted = new Map<string, number>();

export type StoredVerdict = StatefulVerdict & { imageId: string };

export function serviceVerdictKey(ownerId: string, service: string | null): string {
  return `${SERVICE_PREFIX}${ownerId}:${service ?? ""}`;
}

function digestKey(imageId: string, mounts: string[]): string {
  const hash = createHash("sha256").update([...mounts].sort().join("\n")).digest("hex").slice(0, 16);
  return `${DIGEST_PREFIX}${imageId}:${hash}`;
}

/** Stamp files present in a container directory. Empty when the shell or path is missing. */
async function listStamps(containerId: string, dir: string): Promise<string[]> {
  const script = 'for f in "$@"; do [ -e "$0/$f" ] && echo "$f"; done; true';
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["exec", containerId, "sh", "-c", script, dir, ...DATA_STAMPS.map((s) => s.file)],
      { env: dockerEnv(), timeout: EXEC_TIMEOUT_MS },
    );
    return String(stdout).split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export interface ProbeDeps {
  findContainer: (owner: { id: string; name: string }, service: string | null) => Promise<{ id: string; image: string } | null>;
  mounts: (containerId: string) => Promise<string[]>;
  imageMeta: (image: string) => Promise<{ id: string; volumes: string[]; labels: Record<string, string> } | null>;
  stamps: (containerId: string, dir: string) => Promise<string[]>;
  cache: { get: (key: string) => Promise<string | null>; set: (key: string, value: string) => Promise<void> };
}

const dockerDeps: ProbeDeps = {
  async findContainer(owner, service) {
    const containers = await listContainers({ id: owner.id, name: owner.name });
    const match = containers.find(
      (c) => c.state === "running" && (!service || c.labels["com.docker.compose.service"] === service),
    );
    return match ? { id: match.id, image: match.image } : null;
  },
  async mounts(containerId) {
    const inspect = await inspectContainer(containerId);
    return inspect.mounts.filter((m) => m.type === "volume" || m.type === "bind").map((m) => m.destination);
  },
  imageMeta: inspectImageMeta,
  stamps: listStamps,
  cache: {
    get: (key) => redis.get(key),
    set: async (key, value) => {
      await redis.set(key, value, "EX", TTL_SECONDS);
    },
  },
};

/** Probes one service and stores its verdict. Null when nothing is running to probe. */
export async function probeServiceStateful(
  owner: { id: string; name: string },
  service: string | null,
  deps: ProbeDeps = dockerDeps,
): Promise<StoredVerdict | null> {
  const container = await deps.findContainer(owner, service);
  if (!container) return null;

  const [meta, mounts] = await Promise.all([deps.imageMeta(container.image), deps.mounts(container.id)]);
  if (!meta?.id) return null;

  const key = digestKey(meta.id, mounts);
  const cached = await deps.cache.get(key).catch(() => null);
  let verdict: StoredVerdict | null = cached ? (JSON.parse(cached) as StoredVerdict) : null;

  if (!verdict) {
    const dataPath = coveredDataPath(meta.volumes, mounts);
    const stamps = dataPath ? await deps.stamps(container.id, dataPath) : [];
    verdict = {
      ...detectStateful({ image: container.image, imageVolumes: meta.volumes, mounts, stamps, labels: meta.labels }),
      imageId: meta.id,
    };
    await deps.cache.set(key, JSON.stringify(verdict)).catch(() => {});
  }

  await deps.cache.set(serviceVerdictKey(owner.id, service), JSON.stringify(verdict)).catch(() => {});
  return verdict;
}

/** Probes every service an app runs. A failure leaves the name fallback in place. */
export async function probeAppStateful(app: UpdatableApp & { id: string; name: string }): Promise<number> {
  let probed = 0;
  for (const entry of appImages(app)) {
    try {
      if (await probeServiceStateful(app, entry.service)) probed++;
    } catch (err) {
      log.warn(`Couldn't probe ${app.name}${entry.service ? `/${entry.service}` : ""}:`, err);
    }
  }
  return probed;
}

/** Probes up to `limit` parent apps with a service that has no verdict yet. Run from the update sweep. */
export async function probeUnknownApps(limit = 5): Promise<number> {
  const { db } = await import("@/lib/db");
  const { apps } = await import("@/lib/db/schema");
  const { isNull } = await import("drizzle-orm");
  const rows = await db
    .select({
      id: apps.id,
      name: apps.name,
      deployType: apps.deployType,
      imageName: apps.imageName,
      composeContent: apps.composeContent,
      composeService: apps.composeService,
    })
    .from(apps)
    .where(isNull(apps.parentAppId));

  const targets = rows.flatMap((app) => appImages(app).map((e) => ({ ownerId: app.id, service: e.service })));
  const known = await readStatefulVerdicts(targets);
  const now = Date.now();
  const pending = rows.filter(
    (app) =>
      (attempted.get(app.id) ?? 0) < now - RETRY_UNKNOWN_MS &&
      appImages(app).some((e) => !known.has(serviceVerdictKey(app.id, e.service))),
  );
  let probed = 0;
  for (const app of pending.slice(0, limit)) {
    attempted.set(app.id, now);
    probed += await probeAppStateful(app);
  }
  return probed;
}

/** Stored verdicts for many services in one round trip. Missing ones fall back to names. */
export async function readStatefulVerdicts(
  targets: { ownerId: string; service: string | null }[],
): Promise<Map<string, StatefulVerdict>> {
  const result = new Map<string, StatefulVerdict>();
  if (targets.length === 0) return result;
  const keys = targets.map((t) => serviceVerdictKey(t.ownerId, t.service));
  try {
    const values = await redis.mget(...keys);
    values.forEach((raw, i) => {
      if (!raw) return;
      try {
        result.set(keys[i], JSON.parse(raw) as StatefulVerdict);
      } catch {
        // Unreadable entries fall back to names.
      }
    });
  } catch (err) {
    log.warn("Couldn't read stateful verdicts:", err);
  }
  return result;
}
