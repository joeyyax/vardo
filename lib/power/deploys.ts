// The deploy policy's record and its per-deploy override.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { plural } from "@/lib/email/format";
import { recordPowerAction } from "./actions";

async function appNamesOf(deploymentIds: string[]): Promise<string[]> {
  const rows = await db
    .select({ name: apps.displayName })
    .from(deployments)
    .innerJoin(apps, eq(apps.id, deployments.appId))
    .where(inArray(deployments.id, deploymentIds));
  return [...new Set(rows.map((r) => r.name))];
}

/** Deploys the claim just started holding for power. */
export async function recordDeploysHeld(deploymentIds: string[], outage: string | null, now = new Date()): Promise<void> {
  const names = await appNamesOf(deploymentIds).catch(() => []);
  const n = deploymentIds.length;
  await recordPowerAction(
    {
      kind: "deploys-held",
      title: `Holding ${plural(n, "deploy")} on battery`,
      message: `The host is on battery, so new deploys wait until power is back${names.length ? `: ${names.join(", ")}` : ""}. An admin can start one anyway from its deploy.`,
      outage,
      count: n,
      detail: { ids: deploymentIds, names },
      notify: "throttled",
    },
    now,
  );
}

/** Lets a queued deploy past the power hold. False when it isn't queued. */
export async function allowOnBattery(deploymentId: string): Promise<boolean> {
  const { lockClaims } = await import("@/lib/deploy/queue");
  const rows = await db.transaction(async (tx) => {
    await lockClaims(tx);
    return tx
      .update(deployments)
      .set({ request: sql`coalesce(${deployments.request}, '{}'::jsonb) || '{"powerOverride": true}'::jsonb` })
      .where(and(eq(deployments.id, deploymentId), eq(deployments.status, "queued")))
      .returning({ id: deployments.id });
  });
  return rows.length > 0;
}

/** Records an admin's override. */
export async function recordDeployOverride(appName: string, by: string, outage: string | null, now = new Date()): Promise<void> {
  await recordPowerAction(
    {
      kind: "deploy-override",
      title: `Deploying ${appName} on battery`,
      message: `${by} started a held deploy of ${appName} while the host is on battery.`,
      outage,
      count: 1,
      detail: { names: [appName] },
      notify: "never",
    },
    now,
  );
}
