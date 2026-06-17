import { db } from "@/lib/db";
import { apps, projects, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { stopProject } from "./deploy";
import { listVolumes, removeVolume, stripDockerProjectPrefix } from "./client";
import { recordActivity } from "@/lib/activity";

export type DeleteAppResult = {
  deleted: boolean;
  appId: string;
  appName: string;
  pruneVolumes: boolean;
  /** Docker volumes actually removed. */
  removedVolumes: string[];
  /** Volumes matched by keepVolumes and deliberately preserved. */
  keptVolumes: string[];
  /** Candidate volumes left in place because removal failed (e.g. still in use). */
  skippedVolumes: string[];
  /** Child app records removed alongside a parent compose app. */
  removedChildApps: string[];
  log: string;
};

/**
 * Strip a trailing blue/green slot suffix from a compose project name so that
 * `agents`, `agents-blue` and `agents-green` all resolve to the same base.
 * Leaves environment-scoped projects (e.g. `agents-pr-166`) untouched so they
 * are never matched when deleting the base app.
 */
function stripSlotSuffix(project: string): string {
  return project.replace(/-(blue|green)$/, "");
}

/**
 * Delete a compose app and (optionally) its named volumes.
 *
 * Volume handling is conservative by design — destroying the wrong volume is
 * unrecoverable:
 *
 *   - `pruneVolumes: false` (default) removes NO volumes. Containers and
 *     networks are torn down with `docker compose down` (no `--volumes`); every
 *     named volume survives. This is the safe path for deleting an app whose
 *     data (or a sibling's data, e.g. an OAuth credential volume) must persist.
 *
 *   - `pruneVolumes: true` removes only the volumes this app *declares* (its
 *     `persistentVolumes` / `volumes` table rows, plus those of its compose
 *     children when deleting a parent), scoped to the app's own compose project.
 *     Volumes Vardo does not know the app declared — including unrelated stack
 *     volumes — are never touched. Names listed in `keepVolumes` are preserved
 *     even when pruning. A volume still in use by a running container is left in
 *     place (reported under `skippedVolumes`) rather than force-removed.
 *
 * `keepVolumes` entries match either the full Docker volume name
 * (`agents_claude-auth`) or the compose-stripped suffix (`claude-auth`).
 */
export async function deleteApp(opts: {
  appId: string;
  organizationId: string;
  userId?: string;
  pruneVolumes?: boolean;
  keepVolumes?: string[];
  /**
   * Allow deleting a system-managed app. Off by default so user-facing delete
   * paths can't remove platform/integration apps; the integration-install
   * rollback (#741) sets it to undo a failed first deploy.
   */
  allowSystemManaged?: boolean;
}): Promise<DeleteAppResult> {
  const { appId, organizationId } = opts;
  const pruneVolumes = opts.pruneVolumes ?? false;
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
      persistentVolumes: true,
    },
  });

  if (!app) throw new Error("App not found or access denied");
  if (app.isSystemManaged && !opts.allowSystemManaged) {
    throw new Error("System-managed apps cannot be deleted");
  }

  // Resolve the compose project base name. A decomposed child's containers and
  // volumes live under the parent's compose project, so prune against that.
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

  // Direct compose children of this app (only relevant when deleting a parent).
  const childApps = await db.query.apps.findMany({
    where: and(
      eq(apps.parentAppId, appId),
      eq(apps.organizationId, organizationId)
    ),
    columns: { id: true, name: true, persistentVolumes: true },
  });

  // Bring containers down WITHOUT removing volumes — always safe first step.
  const stop = await stopProject(appId, app.name, undefined, false);
  if (stop.log.trim()) logs.push(stop.log.trim());

  const removedVolumes: string[] = [];
  const keptVolumes: string[] = [];
  const skippedVolumes: string[] = [];

  if (pruneVolumes) {
    // The set of short volume names this app (and its children) declared.
    const declaredShortNames = new Set<string>();
    const appIds = [appId, ...childApps.map((c) => c.id)];
    for (const pv of app.persistentVolumes ?? []) declaredShortNames.add(pv.name);
    for (const c of childApps) {
      for (const pv of c.persistentVolumes ?? []) declaredShortNames.add(pv.name);
    }
    const volumeRows = await db.query.volumes.findMany({
      where: eq(volumes.organizationId, organizationId),
      columns: { name: true, appId: true },
    });
    for (const row of volumeRows) {
      if (row.appId && appIds.includes(row.appId)) declaredShortNames.add(row.name);
    }

    const keepSet = new Set(keepVolumes);

    // Only ever consider volumes that (a) belong to this app's compose project
    // and (b) are a volume this app declared. Everything else is left alone.
    const dockerVolumes = await listVolumes();
    for (const vol of dockerVolumes) {
      const project = vol.labels["com.docker.compose.project"];
      if (!project) continue;
      if (stripSlotSuffix(project) !== baseProject) continue;

      const suffix = stripDockerProjectPrefix(vol.name);
      if (!declaredShortNames.has(suffix)) continue;

      if (keepSet.has(vol.name) || keepSet.has(suffix)) {
        keptVolumes.push(vol.name);
        continue;
      }

      try {
        await removeVolume(vol.name);
        removedVolumes.push(vol.name);
        logs.push(`Removed volume ${vol.name}`);
      } catch (err) {
        // In use by a running container, or already gone — keep it.
        skippedVolumes.push(vol.name);
        logs.push(
          `Kept volume ${vol.name} (removal failed: ${err instanceof Error ? err.message : String(err)})`
        );
      }
    }
  }

  // Remove child app records when deleting a parent compose app, then the app.
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
  if (app.projectId) {
    const remaining = await db.query.apps.findFirst({
      where: eq(apps.projectId, app.projectId),
      columns: { id: true },
    });
    if (!remaining) {
      await db.delete(projects).where(eq(projects.id, app.projectId));
    }
  }

  await recordActivity({
    organizationId,
    action: "app.deleted",
    userId: opts.userId,
    metadata: {
      name: app.name,
      source: "mcp",
      pruneVolumes,
      removedVolumes,
      keptVolumes,
      removedChildApps,
    },
  });

  return {
    deleted: true,
    appId,
    appName: app.name,
    pruneVolumes,
    removedVolumes,
    keptVolumes,
    skippedVolumes,
    removedChildApps,
    log: logs.join("\n"),
  };
}
