// Post-deploy work that didn't finish. The row keeps `status: "success"` so it stays a valid rollback target.

import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import type { DeployContext } from "./deploy-context";

/** Record unfinished post-deploy work against a successful deploy. Never throws. */
export async function recordPostDeployIncomplete(
  ctx: DeployContext,
  reason: string,
): Promise<void> {
  ctx.log(`[deploy] Post-deploy work did not finish — ${reason}`);

  try {
    await db
      .update(deployments)
      .set({
        // Appended; one deploy can leave several things undone.
        postDeployError: sql`concat_ws(chr(10), ${deployments.postDeployError}, ${reason})`,
        log: ctx.logLines.join("\n"),
      })
      .where(eq(deployments.id, ctx.deploymentId));
  } catch {
    // Best effort.
  }

  const projectName = ctx.app.displayName || ctx.app.name;

  try {
    const { emit } = await import("@/lib/notifications/dispatch");
    emit(ctx.organizationId, {
      type: "deploy.incomplete",
      title: `Post-deploy work unfinished: ${projectName}`,
      message: `${projectName} is deployed and serving, but ${reason}`,
      projectName,
      appId: ctx.appId,
      deploymentId: ctx.deploymentId,
      reason,
    });
  } catch {
    // Notification dispatch is best-effort.
  }

  recordActivity({
    organizationId: ctx.organizationId,
    action: "deployment.post_deploy_incomplete",
    appId: ctx.appId,
    metadata: { deploymentId: ctx.deploymentId, reason },
  }).catch(() => {});
}
