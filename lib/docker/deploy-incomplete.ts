// ---------------------------------------------------------------------------
// Post-deploy work that did not finish
//
// The third terminal state: the deploy cut over, recorded success and is
// serving, but something behind it — a hook, a notification, the old slot's
// stop — did not complete. The row keeps `status: "success"` so it stays the
// live release and a valid rollback target, and carries what was left undone.
// ---------------------------------------------------------------------------

import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { recordActivity } from "@/lib/activity";
import type { DeployContext } from "./deploy-context";

/**
 * Record unfinished post-deploy work against a deploy that already succeeded.
 * Never throws — the release is live either way.
 */
export async function recordPostDeployIncomplete(
  ctx: DeployContext,
  reason: string,
): Promise<void> {
  ctx.log(`[deploy] Post-deploy work did not finish — ${reason}`);

  try {
    await db
      .update(deployments)
      .set({
        // Appended: one deploy can leave more than one thing undone.
        postDeployError: sql`concat_ws(chr(10), ${deployments.postDeployError}, ${reason})`,
        log: ctx.logLines.join("\n"),
      })
      .where(eq(deployments.id, ctx.deploymentId));
  } catch {
    // Best effort — the log line above still carries it.
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
