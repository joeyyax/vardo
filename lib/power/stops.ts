// The stop policy: stops apps on a long outage or a low battery, and restarts them once mains holds.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { apps, deployments, powerStoppedApps, type PowerStopOutcome, type PowerStoppedAppRow } from "@/lib/db/schema";
import { plural } from "@/lib/email/format";
import { logger } from "@/lib/logger";
import { getPowerState } from "@/lib/ups/power-state";
import { IntervalLoop } from "@/lib/worker/interval-loop";
import { recordPowerAction, stopPassRan } from "./actions";
import { decideStep, outageKey, planRestarts, planStops, powerMode, type StopCandidate, type StopTrigger } from "./policy";
import { getPowerPolicies } from "./settings";

const log = logger.child("power");

export const POWER_POLICY_INTERVAL_MS = 15_000;

/** Stops and starts an app. Swapped out in tests. */
export type AppControl = {
  stop: (app: StopCandidate) => Promise<{ success: boolean; log: string }>;
  start: (app: StopCandidate) => Promise<{ success: boolean; log: string }>;
};

const dockerControl: AppControl = {
  async stop(app) {
    const { stopProject } = await import("@/lib/docker/deploy");
    const { setParked } = await import("@/lib/db/app-parked");
    const { recordLifecycle } = await import("@/lib/activity/lifecycle");
    const startedAt = Date.now();
    const result = await stopProject(app.id, app.name);
    if (result.success) {
      await setParked(app.id, true);
      await recordLifecycle({ organizationId: app.organizationId, app, kind: "stopped", trigger: "power", durationMs: Date.now() - startedAt });
    }
    return result;
  },
  async start(app) {
    const { startOrRestartApp } = await import("@/lib/docker/start-app");
    return startOrRestartApp({ organizationId: app.organizationId, app: { ...app, composeService: null }, trigger: "power" });
  },
};

const CANDIDATE_COLUMNS = {
  id: true,
  name: true,
  displayName: true,
  organizationId: true,
  parentAppId: true,
  status: true,
  parked: true,
  priority: true,
  isSystemManaged: true,
  keepRunningOnBattery: true,
} as const;

async function loadCandidates(ids?: string[]): Promise<StopCandidate[]> {
  return db.query.apps.findMany({
    where: ids ? inArray(apps.id, ids) : isNull(apps.parentAppId),
    columns: CANDIDATE_COLUMNS,
  });
}

/** Apps with a deploy running, which the stop pass leaves to finish. */
async function deployingAppIds(): Promise<Set<string>> {
  const rows = await db.select({ appId: deployments.appId }).from(deployments).where(eq(deployments.status, "running"));
  return new Set(rows.map((r) => r.appId));
}

export async function openStops(): Promise<PowerStoppedAppRow[]> {
  return db.select().from(powerStoppedApps).where(isNull(powerStoppedApps.restoredAt));
}

/** Stops every app the policy may stop, lowest priority first, and records each before it goes down. */
export async function stopForPower(outage: string, trigger: StopTrigger, now = new Date(), control: AppControl = dockerControl): Promise<string[]> {
  const deploying = await deployingAppIds();
  const plan = planStops(await loadCandidates()).filter((a) => !deploying.has(a.id));
  const stopped: string[] = [];
  const failed: string[] = [];
  for (const app of plan) {
    const id = nanoid();
    const [row] = await db
      .insert(powerStoppedApps)
      .values({ id, appId: app.id, organizationId: app.organizationId, outageStartedAt: new Date(outage), stoppedAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: powerStoppedApps.id });
    if (!row) continue;
    const result = await control.stop(app).catch((err: unknown) => ({ success: false, log: err instanceof Error ? err.message : String(err) }));
    if (result.success) {
      stopped.push(app.displayName);
      log.info(`Stopped ${app.name} ${trigger.text}`);
    } else {
      failed.push(app.displayName);
      await db.delete(powerStoppedApps).where(eq(powerStoppedApps.id, id));
      log.warn(`Couldn't stop ${app.name} on battery: ${result.log}`);
    }
  }
  const skipped = deploying.size > 0 ? " Apps mid-deploy were left to finish." : "";
  await recordPowerAction(
    {
      kind: "apps-stopped",
      title: stopped.length ? `Stopped ${plural(stopped.length, "app")} ${trigger.text}` : `Nothing to stop ${trigger.text}`,
      message: stopped.length
        ? `The host is on battery, so Vardo stopped ${stopped.join(", ")}. They restart once power has been back for 2 minutes.${failed.length ? ` Couldn't stop ${failed.join(", ")}.` : ""}${skipped}`
        : `The stop policy ran ${trigger.text}, but every running app is kept on battery or is part of Vardo.${failed.length ? ` Couldn't stop ${failed.join(", ")}.` : ""}${skipped}`,
      outage,
      count: stopped.length,
      detail: { names: stopped, ...(failed.length ? { failed } : {}) },
      notify: stopped.length || failed.length ? "always" : "never",
    },
    now,
  );
  return stopped;
}

async function closeStop(id: string, outcome: PowerStopOutcome, error?: string): Promise<void> {
  await db
    .update(powerStoppedApps)
    .set({ restoredAt: new Date(), outcome, error: error ?? null })
    .where(and(eq(powerStoppedApps.id, id), isNull(powerStoppedApps.restoredAt)));
}

/** Starts the apps the policy stopped, highest priority first. An app someone started meanwhile is left as it is. */
export async function restartStopped(
  rows: PowerStoppedAppRow[],
  now = new Date(),
  control: AppControl = dockerControl,
  stillMains: () => Promise<boolean> = async () => powerMode(await getPowerState()) === "mains",
): Promise<string[]> {
  const byApp = new Map(rows.map((r) => [r.appId, r]));
  const found = await loadCandidates([...byApp.keys()]);
  for (const r of rows) if (!found.some((a) => a.id === r.appId)) await closeStop(r.id, "gone");
  const restarted: string[] = [];
  const failed: string[] = [];
  for (const app of planRestarts(found)) {
    if (!(await stillMains())) break;
    const row = byApp.get(app.id)!;
    if (app.status !== "stopped" || !app.parked) {
      await closeStop(row.id, "already-running");
      continue;
    }
    const result = await control.start(app).catch((err: unknown) => ({ success: false, log: err instanceof Error ? err.message : String(err) }));
    if (result.success) {
      restarted.push(app.displayName);
      await closeStop(row.id, "restarted");
    } else {
      failed.push(app.displayName);
      await closeStop(row.id, "failed", result.log.slice(0, 2000));
      log.warn(`Couldn't restart ${app.name} after the outage: ${result.log}`);
    }
  }
  if (restarted.length || failed.length) {
    await recordPowerAction(
      {
        kind: "apps-restarted",
        title: restarted.length ? `Restarted ${plural(restarted.length, "app")}` : `Couldn't restart ${plural(failed.length, "app")}`,
        message: `Power has been back for 2 minutes.${restarted.length ? ` Vardo restarted the apps it stopped: ${restarted.join(", ")}.` : ""}${failed.length ? ` Couldn't restart ${failed.join(", ")}; start ${failed.length === 1 ? "it" : "them"} from the app page.` : ""}`,
        outage: null,
        count: restarted.length,
        detail: { names: restarted, ...(failed.length ? { failed } : {}) },
        notify: "always",
      },
      now,
    );
  }
  return restarted;
}

/** When mains was first seen in the current run of mains readings. In memory: a restart only lengthens the settle. */
let mainsSince: number | null = null;

export function resetPowerPolicyClock(): void {
  mainsSince = null;
}

/** One pass of the stop policy. */
export async function tickPowerPolicy(now = new Date(), control: AppControl = dockerControl): Promise<void> {
  const [power, policies, open] = await Promise.all([getPowerState(now), getPowerPolicies(), openStops()]);
  const outage = outageKey(power);
  const stoppedOutage = outage && (await stopPassRan(outage)) ? outage : null;
  const decided = decideStep({ power, policies, now, mainsSince, openStops: open.length, stoppedOutage });
  mainsSince = decided.mainsSince;
  if (decided.step.action === "stop") await stopForPower(decided.step.outage, decided.step.trigger, now, control);
  else if (decided.step.action === "restart") await restartStopped(open, now, control);
}

export const powerPolicyLoop = new IntervalLoop({
  name: "power-policy",
  intervalMs: POWER_POLICY_INTERVAL_MS,
  firstRunMs: 20_000,
  log,
  run: () => tickPowerPolicy(),
});
