import { db } from "@/lib/db";
import { apps, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { stopProject } from "./deploy";
import { assertAppDirOwnership, removeAppDir } from "./app-dir-owner";
import { removeVolume, stripDockerProjectPrefix } from "./client";
import { appBindPaths, findAppData } from "./app-data";
import { appBaseDir } from "@/lib/paths";
import { recordActivity } from "@/lib/activity";

export type DeleteAppResult = {
  deleted: boolean;
  appId: string;
  appName: string;
  deleteVolumes: boolean;
  /** Docker volumes actually removed. */
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

/**
 * Delete an app, keeping its data unless asked otherwise.
 *
 * `deleteVolumes: false` (default) keeps every volume the app owns and every
 * bind-mounted path inside its directory; the rest of the directory goes.
 * `deleteVolumes: true` removes them, except names listed in `keepVolumes`
 * (full Docker name or the compose-stripped suffix). A volume still in use is
 * left in place and reported under `skippedVolumes`.
 */
export async function deleteApp(opts: {
  appId: string;
  organizationId: string;
  userId?: string;
  deleteVolumes?: boolean;
  keepVolumes?: string[];
  /** Recorded in the activity log. */
  source?: "api" | "mcp" | "system";
  /**
   * Allow deleting a system-managed app. Off by default so user-facing delete
   * paths can't remove platform/integration apps; the integration-install
   * rollback (#741) sets it to undo a failed first deploy.
   */
  allowSystemManaged?: boolean;
  /**
   * Allow deleting a decomposed compose child (a service of a parent stack).
   * Off by default so user-facing paths refuse — the service is declared in
   * the parent's compose and a deploy would just recreate it. No internal
   * caller needs this today; it's a deliberate escape hatch.
   */
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

  // A decomposed child is managed by its parent stack — refuse independent
  // deletes (the compose still declares the service; a deploy recreates it).
  if (app.parentAppId && !opts.allowChildDelete) {
    throw new Error(
      `"${app.name}" is a service of the "${baseProject}" compose stack and can't be deleted on its own — remove it from the stack's compose file and redeploy.`,
    );
  }

  // Direct compose children of this app (only relevant when deleting a parent).
  const childApps = await db.query.apps.findMany({
    where: and(
      eq(apps.parentAppId, appId),
      eq(apps.organizationId, organizationId)
    ),
    columns: { id: true, name: true },
  });

  // Throws before anything is torn down or removed from the database, so a
  // refusal can't leave another org's containers running with the row gone.
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

  // A decomposed child has no directory of its own — the parent owns it.
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

  // Remove child app records when deleting a parent compose app, then the app.
  // The parent_app_id FK cascades too — this runs first only so the deleted
  // service names can be reported. Do not rely on it as the sole cleanup.
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

  // Clean up the project if this was its last app.
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
