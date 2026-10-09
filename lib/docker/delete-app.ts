import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { stopProject } from "./deploy";
import { assertAppDirOwnership, removeAppDir } from "./app-dir-owner";
import { removeVolume, stripDockerProjectPrefix } from "./client";
import { appBindPaths, findAppData } from "./app-data";
import { appBaseDir } from "@/lib/paths";
import { removeAppContainersAndNetworks } from "./delete-teardown";
import { deleteEmptyAutoJobs } from "@/lib/backups/auto-backup";
import { logger } from "@/lib/logger";
import { recordActivity } from "@/lib/activity";
import { deleteAppSeries } from "@/lib/metrics/series-cleanup";

const log = logger.child("delete-app");

export type DeleteAppResult = {
  deleted: boolean;
  appId: string;
  appName: string;
  deleteVolumes: boolean;
  /** Docker volumes removed. */
  removedVolumes: string[];
  /** Volumes left in place: all of them unless deleteVolumes, plus keepVolumes matches. */
  keptVolumes: string[];
  /** Volumes left in place because removal failed (e.g. still in use). */
  skippedVolumes: string[];
  /** Bind-mounted paths inside the app directory left in place. */
  keptPaths: string[];
  /** Child app records removed alongside a parent compose app. */
  removedChildApps: string[];
  /** Whether the app's directory under PROJECTS_DIR was removed. */
  removedAppDir: boolean;
  /** The project removed because this was its last app. */
  deletedProject: { id: string; name: string } | null;
  log: string;
};

/** Delete an app. Volumes and bind paths are kept unless `deleteVolumes`, minus `keepVolumes` matches. */
export async function deleteApp(opts: {
  appId: string;
  organizationId: string;
  userId?: string;
  deleteVolumes?: boolean;
  keepVolumes?: string[];
  /** Recorded in the activity log. */
  source?: "api" | "mcp" | "system";
  /** Allow deleting a system-managed app. Only the integration-install rollback sets it (#741). */
  allowSystemManaged?: boolean;
  /** Allow deleting a decomposed compose child. A parent deploy would recreate it. */
  allowChildDelete?: boolean;
}): Promise<DeleteAppResult> {
  const { appId, organizationId } = opts;
  const deleteVolumes = opts.deleteVolumes === true;
  const keepVolumes = opts.keepVolumes ?? [];
  const logs: string[] = [];

  const app = await db.query.apps.findFirst({
    where: and(eq(apps.id, appId), eq(apps.organizationId, organizationId)),
    columns: {
      id: true,
      name: true,
      projectId: true,
      parentAppId: true,
      isSystemManaged: true,
    },
  });

  if (!app) throw new Error("App not found or access denied");
  if (app.isSystemManaged && !opts.allowSystemManaged) {
    throw new Error("System-managed apps cannot be deleted");
  }

  // A decomposed child's containers live under the parent's compose project.
  let baseProject = app.name;
  if (app.parentAppId) {
    const parent = await db.query.apps.findFirst({
      where: and(
        eq(apps.id, app.parentAppId),
        eq(apps.organizationId, organizationId)
      ),
      columns: { name: true },
    });
    if (parent) baseProject = parent.name;
  }

  // The parent's compose still declares the child; a deploy would recreate it.
  if (app.parentAppId && !opts.allowChildDelete) {
    throw new Error(
      `"${app.name}" is a service of the "${baseProject}" compose stack and can't be deleted on its own — remove it from the stack's compose file and redeploy.`,
    );
  }

  // Compose children, when deleting a parent.
  const childApps = await db.query.apps.findMany({
    where: and(
      eq(apps.parentAppId, appId),
      eq(apps.organizationId, organizationId)
    ),
    columns: { id: true, name: true },
  });

  // Before any teardown, so a refusal can't leave another org's containers running with the row gone.
  await assertAppDirOwnership({
    appId: app.parentAppId ?? appId,
    appName: baseProject,
    operation: "delete",
  });

  // Read before teardown: the compose files name the bind mounts.
  const data = await findAppData(app);
  const bindPaths = app.parentAppId ? [] : await appBindPaths(app.name);

  // Containers come down without --volumes; removal below is per volume.
  const stop = await stopProject(appId, app.name, undefined, false);
  if (stop.log.trim()) logs.push(stop.log.trim());

  // compose down misses exited and orphaned containers; the id label finds them in any state.
  const leftovers = await removeAppContainersAndNetworks([appId, ...childApps.map((c) => c.id)]);
  logs.push(...leftovers.log);

  const removedVolumes: string[] = [];
  const keptVolumes: string[] = [];
  const skippedVolumes: string[] = [];
  const keepSet = new Set(keepVolumes);

  for (const { name } of data.volumes) {
    if (!deleteVolumes || keepSet.has(name) || keepSet.has(stripDockerProjectPrefix(name))) {
      keptVolumes.push(name);
      continue;
    }
    try {
      await removeVolume(name);
      removedVolumes.push(name);
      logs.push(`Removed volume ${name}`);
    } catch (err) {
      skippedVolumes.push(name);
      logs.push(
        `Kept volume ${name} (removal failed: ${err instanceof Error ? err.message : String(err)})`
      );
    }
  }

  // A decomposed child's directory belongs to the parent.
  let removedAppDir = false;
  const keptPaths: string[] = [];
  if (!app.parentAppId) {
    const removal = await removeAppDir({
      appId,
      appName: app.name,
      keep: deleteVolumes ? [] : bindPaths,
    });
    removedAppDir = removal.removed;
    keptPaths.push(...(removal.kept ?? []));
    logs.push(
      removal.removed
        ? `Removed ${appBaseDir(app.name)}`
        : `Kept ${appBaseDir(app.name)} (${removal.reason})`,
    );
  }

  // Explicit only to report names; the parent_app_id FK cascades too.
  const removedChildApps: string[] = [];
  if (childApps.length > 0) {
    await db
      .delete(apps)
      .where(
        and(eq(apps.parentAppId, appId), eq(apps.organizationId, organizationId))
      );
    removedChildApps.push(...childApps.map((c) => c.name));
  }

  await db
    .delete(apps)
    .where(and(eq(apps.id, appId), eq(apps.organizationId, organizationId)));

  // The app's links are gone, so its "Auto:" jobs are now empty.
  try {
    const removedJobs = await deleteEmptyAutoJobs(organizationId, [app.name, ...childApps.map((c) => c.name)]);
    if (removedJobs.length > 0) logs.push(`Removed ${removedJobs.length} empty backup job(s)`);
  } catch (err) {
    log.warn(`Could not remove the empty backup job for ${app.name}:`, err);
  }

  // A decomposed child's containers report under the parent's project.
  try {
    await deleteAppSeries({
      projects: app.parentAppId ? [] : [app.name],
      appIds: [appId, ...childApps.map((c) => c.id)],
    });
  } catch (err) {
    log.warn(`Could not delete the metrics series for ${app.name}:`, err);
  }

  // Remove the project if this was its last app.
  let deletedProject: DeleteAppResult["deletedProject"] = null;
  if (app.projectId) {
    const remaining = await db.query.apps.findFirst({
      where: eq(apps.projectId, app.projectId),
      columns: { id: true },
    });
    if (!remaining) {
      const [row] = await db
        .delete(projects)
        .where(eq(projects.id, app.projectId))
        .returning({ id: projects.id, name: projects.name });
      deletedProject = row ?? null;
    }
  }

  await recordActivity({
    organizationId,
    action: "app.deleted",
    userId: opts.userId,
    metadata: {
      name: app.name,
      source: opts.source ?? "system",
      deleteVolumes,
      removedVolumes,
      keptVolumes,
      keptPaths,
      removedChildApps,
      removedAppDir,
    },
  });

  return {
    deleted: true,
    appId,
    appName: app.name,
    deleteVolumes,
    removedVolumes,
    keptVolumes,
    skippedVolumes,
    keptPaths,
    removedChildApps,
    removedAppDir,
    deletedProject,
    log: logs.join("\n"),
  };
}
