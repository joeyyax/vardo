import { db } from "@/lib/db";
import { volumes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { listContainers, inspectContainer, stripDockerProjectPrefix } from "../client";
import { volumeThreshold } from "@/lib/volumes/threshold";
import { DeployBlockedError } from "../errors";
import { DOCKER_CLEANUP_TIMEOUT } from "../constants";
import type { DeployContext } from "../deploy-context";
import { execFileAsync } from "@/lib/utils/exec";

/**
 * Block the deploy when a volume the running app mounts is over its limit.
 * Runs before the old slot is touched, so a blocked deploy leaves it serving.
 */
export async function checkVolumeLimits(ctx: DeployContext): Promise<void> {
  const { app, log } = ctx;
  try {
    const limitedVolumes = await db.query.volumes.findMany({
      where: eq(volumes.appId, ctx.appId),
    });
    if (!limitedVolumes.some((v) => v.maxSizeBytes != null)) return;

    const { formatBytes } = await import("@/lib/metrics/format");
    const runningContainers = await listContainers({ id: ctx.appId, name: app.name }, ctx.envName);

    const volEntries: { volName: string; displayName: string }[] = [];
    const seen = new Set<string>();
    for (const c of runningContainers) {
      const info = await inspectContainer(c.id);
      for (const mount of info.mounts) {
        if (mount.type !== "volume" || !mount.name || seen.has(mount.name)) continue;
        if (!/^[a-zA-Z0-9._-]+$/.test(mount.name)) continue;
        seen.add(mount.name);
        volEntries.push({ volName: mount.name, displayName: stripDockerProjectPrefix(mount.name) });
      }
    }
    if (volEntries.length === 0) return;

    const limitByName = new Map(
      limitedVolumes
        .filter((v) => v.maxSizeBytes != null)
        .map((v) => [v.name, { maxSizeBytes: v.maxSizeBytes!, warnAtPercent: v.warnAtPercent ?? 80 }]),
    );

    const results = await Promise.allSettled(
      volEntries.map(({ volName }) =>
        execFileAsync(
          "docker",
          ["run", "--rm", "-v", `${volName}:/data`, "alpine", "du", "-sb", "/data"],
          { timeout: DOCKER_CLEANUP_TIMEOUT },
        ),
      ),
    );

    let overLimit = false;
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status !== "fulfilled") continue;
      const sizeBytes = parseInt(result.value.stdout.split("\t")[0]);
      if (isNaN(sizeBytes)) continue;
      const { displayName } = volEntries[i];
      const limit = limitByName.get(displayName);
      if (!limit) continue;

      const percent = Math.round((sizeBytes / limit.maxSizeBytes) * 100);
      const level = volumeThreshold(sizeBytes, limit.maxSizeBytes, limit.warnAtPercent);
      const usage = `${formatBytes(sizeBytes)} / ${formatBytes(limit.maxSizeBytes)} (${percent}%)`;

      if (level === "critical") {
        log(`[deploy] Volume '${displayName}': ${usage} -- OVER LIMIT, deploy blocked`);
        overLimit = true;
      } else if (level === "warning") {
        log(`[deploy] WARNING: Volume '${displayName}': ${usage}`);
      } else {
        log(`[deploy] Volume '${displayName}': ${usage}`);
      }
    }

    if (overLimit) {
      throw new DeployBlockedError(
        "One or more volumes exceed the configured storage limit. Reduce volume usage or increase the limit in app settings.",
      );
    }
  } catch (err) {
    if (err instanceof DeployBlockedError) throw err;
  }
}
