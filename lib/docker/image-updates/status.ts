import { refCacheKey } from "./image-ref";
import { appImages, type UpdatableApp } from "./compose-images";
import { readCachedChecks, CHECK_TTL_MS } from "./check";
import type { BumpSeverity } from "./tag-version";
import type { CheckStatus } from "./check";

/**
 * Read-only view over the cache. Page loads call this and never touch a
 * registry, so rendering an app costs nothing against the pull budget.
 */

export interface ServiceUpdateStatus {
  service: string | null;
  image: string;
  currentTag: string;
  status: CheckStatus;
  latestTag: string | null;
  severity: BumpSeverity | null;
  unorderable: string[];
  error: string | null;
  checkedAt: string | null;
  /** True when the cached answer is past its TTL. */
  stale: boolean;
}

export interface AppUpdateStatus {
  services: ServiceUpdateStatus[];
  /** Services with a newer tag or a drifted floating tag. */
  updateCount: number;
  /** Highest severity among available updates, for UI emphasis. */
  highestSeverity: BumpSeverity | null;
  /** True when at least one service could not be answered. */
  hasUnknown: boolean;
}

const SEVERITY_RANK: Record<BumpSeverity, number> = {
  build: 1,
  patch: 2,
  minor: 3,
  major: 4,
  unknown: 0,
};

export async function getAppUpdateStatus(app: UpdatableApp): Promise<AppUpdateStatus> {
  const entries = appImages(app);
  const cached = await readCachedChecks(entries.map((entry) => refCacheKey(entry.ref)));
  const cutoff = Date.now() - CHECK_TTL_MS;

  const services: ServiceUpdateStatus[] = entries.map((entry) => {
    const row = cached.get(refCacheKey(entry.ref));
    return {
      service: entry.service,
      image: entry.image,
      currentTag: entry.ref.tag,
      status: row?.status ?? "unknown",
      latestTag: row?.latestTag ?? null,
      severity: (row?.severity as BumpSeverity | null) ?? null,
      unorderable: row?.unorderable ?? [],
      error: row?.error ?? (row ? null : "Not checked yet"),
      checkedAt: row?.checkedAt.toISOString() ?? null,
      stale: !row || row.checkedAt.getTime() < cutoff,
    };
  });

  let highest: BumpSeverity | null = null;
  let updateCount = 0;
  let hasUnknown = false;

  for (const service of services) {
    if (service.status === "unknown") hasUnknown = true;
    if (service.status !== "update" && service.status !== "drift") continue;
    updateCount++;
    const severity = service.severity ?? "unknown";
    if (!highest || SEVERITY_RANK[severity] > SEVERITY_RANK[highest]) highest = severity;
  }

  return { services, updateCount, highestSeverity: highest, hasUnknown };
}

export interface AggregateUpdateStatus {
  appsWithUpdates: { id: string; name: string; displayName: string; count: number }[];
  totalUpdates: number;
  unknownCount: number;
  /** Set while a registry rate limit is being waited out. */
  cooldownUntil: string | null;
}

type AggregateApp = UpdatableApp & { id: string; name: string; displayName: string };

/** Rolls per-app state up for the org-wide banner. One cache read, no fan-out. */
export async function getAggregateUpdateStatus(
  appRows: AggregateApp[],
  cooldownUntil: number,
): Promise<AggregateUpdateStatus> {
  const all = appRows.flatMap((app) =>
    appImages(app).map((entry) => refCacheKey(entry.ref)),
  );
  const cached = await readCachedChecks([...new Set(all)]);

  const appsWithUpdates: AggregateUpdateStatus["appsWithUpdates"] = [];
  let totalUpdates = 0;
  let unknownCount = 0;

  for (const app of appRows) {
    let count = 0;
    for (const entry of appImages(app)) {
      const row = cached.get(refCacheKey(entry.ref));
      if (!row || row.status === "unknown") {
        unknownCount++;
        continue;
      }
      if (row.status === "update" || row.status === "drift") count++;
    }
    if (count > 0) {
      appsWithUpdates.push({
        id: app.id,
        name: app.name,
        displayName: app.displayName,
        count,
      });
      totalUpdates += count;
    }
  }

  return {
    appsWithUpdates,
    totalUpdates,
    unknownCount,
    cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null,
  };
}
