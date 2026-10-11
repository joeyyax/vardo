// Every image an app's current config or any of its successful deployments names.
// Any successful deployment can be picked as a rollback target, so all of them are kept.

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { deploymentImageName } from "../image-tag";
import { composeImageRefs, emptyProtection, protectRef, type Protection } from "./policy";

type AppRow = { name: string; imageName: string | null; composeContent: string | null };
type DeploymentRow = {
  id: string;
  appName: string;
  config: { imageName?: string | null; imageDigest?: string | null; composeContent?: string | null } | null;
};

export function buildProtection(appRows: AppRow[], deploymentRows: DeploymentRow[]): Protection {
  const p = emptyProtection();
  for (const app of appRows) {
    protectRef(p, app.imageName);
    for (const ref of composeImageRefs(app.composeContent)) protectRef(p, ref);
  }
  for (const d of deploymentRows) {
    protectRef(p, deploymentImageName(d.appName, d.id));
    protectRef(p, d.config?.imageName);
    protectRef(p, d.config?.imageDigest);
    for (const ref of composeImageRefs(d.config?.composeContent)) protectRef(p, ref);
  }
  return p;
}

export async function loadProtection(): Promise<Protection> {
  const [appRows, deploymentRows] = await Promise.all([
    db.select({ name: apps.name, imageName: apps.imageName, composeContent: apps.composeContent }).from(apps),
    db
      .select({ id: deployments.id, appName: apps.name, config: deployments.configSnapshot })
      .from(deployments)
      .innerJoin(apps, eq(apps.id, deployments.appId))
      .where(eq(deployments.status, "success")),
  ]);
  return buildProtection(appRows, deploymentRows);
}
