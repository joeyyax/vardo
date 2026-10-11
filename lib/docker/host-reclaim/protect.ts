// Images an app's current config or its retained rollback targets name.
// Retained: the newest ROLLBACK_IMAGES_RETAINED successful deployments per app. Older rollbacks re-pull by digest or rebuild.

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { ROLLBACK_IMAGES_RETAINED } from "../constants";
import { deploymentImageName } from "../image-tag";
import { composeImageRefs, emptyProtection, protectRef, type Protection } from "./policy";

type AppRow = { name: string; imageName: string | null; composeContent: string | null };
export type DeploymentRow = {
  id: string;
  appId: string;
  appName: string;
  config: { imageName?: string | null; imageDigest?: string | null; composeContent?: string | null } | null;
};

/** The newest `keep` per app. Rows must arrive newest first. */
export function retainedDeployments<T extends { appId: string }>(rows: T[], keep = ROLLBACK_IMAGES_RETAINED): T[] {
  const seen = new Map<string, number>();
  return rows.filter((row) => {
    const n = seen.get(row.appId) ?? 0;
    seen.set(row.appId, n + 1);
    return n < keep;
  });
}

export function buildProtection(appRows: AppRow[], deploymentRows: DeploymentRow[]): Protection {
  const p = emptyProtection();
  for (const app of appRows) {
    protectRef(p, app.imageName);
    for (const ref of composeImageRefs(app.composeContent)) protectRef(p, ref);
  }
  for (const d of retainedDeployments(deploymentRows)) {
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
      .select({ id: deployments.id, appId: deployments.appId, appName: apps.name, config: deployments.configSnapshot })
      .from(deployments)
      .innerJoin(apps, eq(apps.id, deployments.appId))
      .where(eq(deployments.status, "success"))
      .orderBy(desc(deployments.startedAt)),
  ]);
  return buildProtection(appRows, deploymentRows);
}
