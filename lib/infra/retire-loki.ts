// Loki and Promtail retirement: remove both apps once VictoriaLogs and the log shipper work. Volumes stay. A no-op once its marker is set.

import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { deleteApp } from "@/lib/docker/delete-app";
import { resolveSystemIncident } from "@/lib/incidents/system";
import { recordCoreServiceStatus, removeCoreServiceStatus } from "@/lib/infra/core-services";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { logger } from "@/lib/logger";

const log = logger.child("infra");

/** Promtail first, so nothing writes to Loki while it goes. Probe names are what their service-down incidents are about. */
const RETIRED = [
  { name: "promtail", displayName: "Promtail" },
  { name: "loki", displayName: "Loki" },
] as const;
export const LOKI_RETIRED_KEY = "loki_retired";
const LOCK_KEY = "lock:retire-loki";
const LOCK_TTL_MS = 10 * 60_000;

export type RetireResult = { state: "retired" | "done" | "waiting"; reason?: string };

type Deps = {
  loggingEnabled: () => Promise<boolean>;
  victoriaLogsReady: () => Promise<boolean>;
  /** Unix seconds of the shipper's last delivery, null for none. Rejects when unreachable. */
  shipperLastDelivery: () => Promise<number | null>;
};

const defaultDeps: Deps = {
  loggingEnabled: async () => (await import("@/lib/config/features")).isFeatureEnabledAsync("logging"),
  victoriaLogsReady: async () => (await import("@/lib/logging/victorialogs")).isVictoriaLogsAvailable(),
  shipperLastDelivery: async () => (await import("@/lib/logging/shipper")).shipperLastDelivery(),
};

/** Removes Loki and Promtail, keeping their volumes. With logging off nothing reads them, so they go without the guard. */
export async function retireLoki(deps: Deps = defaultDeps): Promise<RetireResult> {
  if (await getSystemSettingRaw(LOKI_RETIRED_KEY)) return { state: "done" };

  if (await deps.loggingEnabled()) {
    const reason = await guardProblem(deps);
    if (reason) {
      await recordWaiting(reason);
      return { state: "waiting", reason };
    }
  }

  const token = await acquireLock(LOCK_KEY, LOCK_TTL_MS);
  if (!token) return { state: "waiting", reason: "Another process is retiring them." };
  try {
    if (await getSystemSettingRaw(LOKI_RETIRED_KEY)) return { state: "done" };

    for (const service of RETIRED) {
      const app = await findApp(service.name);
      // A tenant's own app by that name isn't Vardo's to remove.
      if (!app?.isSystemManaged) continue;
      try {
        await deleteApp({ appId: app.id, organizationId: app.organizationId, allowSystemManaged: true, deleteVolumes: false, source: "system" });
      } catch (err) {
        const reason = `Couldn't remove ${service.displayName}: ${err instanceof Error ? err.message : String(err)}`;
        await recordWaiting(reason);
        return { state: "waiting", reason };
      }
    }

    const orgs = await db.query.organizations.findMany({ columns: { id: true } }).catch(() => []);
    for (const service of RETIRED) {
      await removeCoreServiceStatus(service.name);
      await resolveSystemIncident(orgs.map((o) => o.id), "system.service-down", service.displayName, `${service.displayName} is retired. VictoriaLogs holds app logs.`);
    }
    await setSystemSetting(LOKI_RETIRED_KEY, new Date().toISOString());
    log.info("Retired Loki and Promtail; their volumes are kept");
    return { state: "retired" };
  } finally {
    await releaseLock(LOCK_KEY, token).catch(() => {});
  }
}

/** Why Loki stays for now, or null once VictoriaLogs and the shipper have proven themselves. */
async function guardProblem(deps: Deps): Promise<string | null> {
  if (!(await deps.victoriaLogsReady().catch(() => false))) return "Stays until VictoriaLogs answers.";
  try {
    if (!(await deps.shipperLastDelivery())) return "Stays until the log shipper has delivered logs.";
  } catch (err) {
    return `Stays while the log shipper can't be read: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

function findApp(name: string) {
  return db.query.apps.findFirst({
    where: and(eq(apps.name, name), isNull(apps.parentAppId)),
    columns: { id: true, organizationId: true, isSystemManaged: true },
  });
}

async function recordWaiting(detail: string): Promise<void> {
  const rows = await Promise.all(RETIRED.map(async (s) => ({ s, app: await findApp(s.name).catch(() => undefined) })));
  await recordCoreServiceStatus(
    rows
      .filter(({ app }) => app?.isSystemManaged)
      .map(({ s, app }) => ({ name: s.name, displayName: s.displayName, flag: "logging" as const, state: "retiring" as const, appId: app!.id, organizationId: app!.organizationId, detail })),
  );
}

/** First try about 10 minutes after boot, then hourly. */
export const retireLokiLoop = new IntervalLoop({
  name: "loki-retire",
  firstRunMs: 10 * 60_000,
  intervalMs: 60 * 60_000,
  log,
  run: async () => {
    const result = await retireLoki();
    if (result.state === "waiting") log.info(`Loki retirement: ${result.reason}`);
  },
});
