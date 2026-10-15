// cAdvisor retirement: remove the leftover app once the collector has served. A no-op once its marker is set.

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { collectorMode } from "@/lib/collector/config";
import { deleteApp } from "@/lib/docker/delete-app";
import { resolveSystemIncident } from "@/lib/incidents/system";
import { recordCoreServiceStatus, removeCoreServiceStatus } from "@/lib/infra/core-services";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { logger } from "@/lib/logger";

const log = logger.child("infra");

const APP_NAME = "cadvisor";
/** The health probe's name, which its service-down incidents are about. */
const PROBE_NAME = "cAdvisor";
const MARKER_KEY = "cadvisor_retired";
/** Written on the collector's first successful read. */
export const FIRST_SERVED_KEY = "collector_first_served_at";
const LOCK_KEY = "lock:retire-cadvisor";
const LOCK_TTL_MS = 10 * 60_000;

/** Records the collector's first successful read. Later calls only read. */
export async function markCollectorServed(now = new Date()): Promise<void> {
  if (await getSystemSettingRaw(FIRST_SERVED_KEY)) return;
  await setSystemSetting(FIRST_SERVED_KEY, now.toISOString());
}

export type RetireResult = { state: "retired" | "done" | "waiting"; reason?: string };

type Deps = {
  /** One read through a fresh collector provider. Rejects when the collector can't serve. */
  readCollector: () => Promise<unknown>;
  env?: Record<string, string | undefined>;
};

const defaultDeps: Deps = {
  readCollector: async () => {
    const mode = collectorMode();
    if (mode.kind === "off") return;
    const { collectorProvider } = await import("@/lib/metrics/config");
    await collectorProvider(mode).fetchAll();
  },
};

/** Removes cAdvisor once nothing could need it. In off mode nothing reads it, so it goes without the guard. */
export async function retireCadvisor(deps: Deps = defaultDeps): Promise<RetireResult> {
  if (await getSystemSettingRaw(MARKER_KEY)) return { state: "done" };

  if (collectorMode(deps.env).kind !== "off") {
    const reason = await guardProblem(deps);
    if (reason) {
      await recordWaiting(reason);
      return { state: "waiting", reason };
    }
  }

  const token = await acquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!token) return { state: "waiting", reason: "Another process is retiring it." };
  try {
    if (await getSystemSettingRaw(MARKER_KEY)) return { state: "done" };

    const app = await db.query.apps.findFirst({
      where: and(eq(apps.name, APP_NAME), isNull(apps.parentAppId)),
      columns: { id: true, organizationId: true, isSystemManaged: true },
    });
    // A tenant's own app by that name isn't Vardo's to remove.
    if (app?.isSystemManaged) {
      try {
        await deleteApp({ appId: app.id, organizationId: app.organizationId, allowSystemManaged: true, source: "system" });
      } catch (err) {
        const reason = `Couldn't remove cAdvisor: ${err instanceof Error ? err.message : String(err)}`;
        await recordWaiting(reason);
        return { state: "waiting", reason };
      }
    }

    await removeCoreServiceStatus(APP_NAME);
    const orgs = await db.query.organizations.findMany({ columns: { id: true } }).catch(() => []);
    await resolveSystemIncident(orgs.map((o) => o.id), "system.service-down", PROBE_NAME, "cAdvisor is retired. The collector reads container metrics.");
    await setSystemSetting(MARKER_KEY, new Date().toISOString());
    log.info(app?.isSystemManaged ? "Retired cAdvisor: removed its app and both slots" : "Retired cAdvisor: nothing to remove");
    return { state: "retired" };
  } finally {
    await releaseLock(LOCK_KEY, token).catch(() => {});
  }
}

/** Why cAdvisor stays for now, or null once the collector has proven itself. */
async function guardProblem(deps: Deps): Promise<string | null> {
  if (!(await getSystemSettingRaw(FIRST_SERVED_KEY))) return "Stays until the collector has served metrics.";
  try {
    await deps.readCollector();
  } catch (err) {
    return `Stays while the collector can't be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

async function recordWaiting(detail: string): Promise<void> {
  const app = await db.query.apps
    .findFirst({ where: and(eq(apps.name, APP_NAME), isNull(apps.parentAppId)), columns: { id: true, organizationId: true } })
    .catch(() => undefined);
  await recordCoreServiceStatus([
    { name: APP_NAME, displayName: "cAdvisor", flag: "metrics", state: "retiring", appId: app?.id ?? null, organizationId: app?.organizationId ?? null, detail },
  ]);
}

/** First try about 10 minutes after boot, then hourly. */
export const retireCadvisorLoop = new IntervalLoop({
  name: "cadvisor-retire",
  firstRunMs: 10 * 60_000,
  intervalMs: 60 * 60_000,
  log,
  run: async () => {
    const result = await retireCadvisor();
    if (result.state === "waiting") log.info(`cAdvisor retirement: ${result.reason}`);
  },
});
