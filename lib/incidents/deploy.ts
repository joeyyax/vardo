// Deploy failures as incidents: a failure opens one per app and environment, the next success resolves it.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import { openIncident, resolveIncidents, safely } from "./store";
import type { IncidentRef } from "./types";

export const DEPLOY_INCIDENT = "deploy.failed";

type DeploySubject = { appId: string; deploymentId: string; displayName: string; environmentId?: string | null };

async function aboutFor(subject: DeploySubject): Promise<string> {
  let environmentId = subject.environmentId;
  if (environmentId === undefined) {
    const row = await db.query.deployments.findFirst({ where: eq(deployments.id, subject.deploymentId), columns: { environmentId: true } });
    environmentId = row?.environmentId ?? null;
  }
  return environmentId ? `${subject.appId}/${environmentId}` : subject.appId;
}

/** The incident a deploy's notice carries: opened or updated on failure, resolved on success, none otherwise. */
export async function deployIncident(organizationId: string, subject: DeploySubject, success: boolean, now = new Date()): Promise<IncidentRef | null> {
  return safely(
    "deploy",
    async () => {
      const about = await aboutFor(subject);
      if (success) return (await resolveIncidents(organizationId, DEPLOY_INCIDENT, [about], now)).get(about) ?? null;
      return openIncident(
        organizationId,
        { kind: DEPLOY_INCIDENT, about, severity: "critical", title: `${subject.displayName} failed to deploy`, appId: subject.appId },
        now,
      );
    },
    null,
  );
}
