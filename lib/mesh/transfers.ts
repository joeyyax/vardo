import { db } from "@/lib/db";
import { apps, projects, projectInstances, volumes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getInstanceId } from "@/lib/constants";
import { narrowBackendProtocol } from "@/lib/docker/compose";

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Check if volume transfers are available.
 * Volume transfers rely on the backup engine — if backups are disabled,
 * only config transfers (compose, git ref, env vars) are possible.
 */
export async function canTransferVolumes(): Promise<boolean> {
  const { isFeatureEnabledAsync } = await import("@/lib/config/features");
  return isFeatureEnabledAsync("backups");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serializable app config within a project bundle. */
export type AppBundle = {
  name: string;
  displayName: string;
  description: string | null;
  source: "git" | "direct";
  deployType: "compose" | "dockerfile" | "image" | "static" | "nixpacks" | "railpack";
  gitUrl: string | null;
  gitBranch: string | null;
  imageName: string | null;
  composeContent: string | null;
  composeFilePath: string | null;
  rootDirectory: string | null;
  autoTraefikLabels: boolean | null;
  containerPort: number | null;
  backendProtocol: "http" | "https" | null;
  restartPolicy: string | null;
  exposedPorts: { internal: number; external?: number; protocol?: string; description?: string }[] | null;
  envContent: string | null; // only included if explicitly requested
  sortOrder: number | null;
  volumes: { name: string; mountPath: string; persistent: boolean }[];
};

/** Serializable project bundle for mesh transfers. */
export type ProjectBundle = {
  sourceInstanceId: string;
  project: {
    name: string;
    displayName: string;
    description: string | null;
    color: string | null;
  };
  apps: AppBundle[];
  gitRef: string | null;
  transferType: "promote" | "pull" | "clone";
  /** Volume backup IDs from the source instance's backup system. */
  volumeBackupIds?: string[];
};

// ---------------------------------------------------------------------------
// Build: extract project data into a transferable bundle
// ---------------------------------------------------------------------------

/**
 * Build a project bundle for transfer to another instance.
 * Extracts project metadata, app configs, and optionally env vars.
 */
export async function buildProjectBundle(
  projectId: string,
  options: {
    transferType: "promote" | "pull" | "clone";
    includeEnvVars?: boolean;
    gitRef?: string | null;
  }
): Promise<ProjectBundle> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: {
      apps: {
        with: {
          volumes: true,
        },
      },
    },
  });

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const appBundles: AppBundle[] = project.apps
    .filter((app) => !app.parentAppId) // only top-level apps (compose parents)
    .map((app) => ({
      name: app.name,
      displayName: app.displayName,
      description: app.description,
      source: app.source,
      deployType: app.deployType,
      gitUrl: app.gitUrl,
      gitBranch: app.gitBranch,
      imageName: app.imageName,
      composeContent: app.composeContent,
      composeFilePath: app.composeFilePath,
      rootDirectory: app.rootDirectory,
      autoTraefikLabels: app.autoTraefikLabels,
      containerPort: app.containerPort,
      backendProtocol: narrowBackendProtocol(app.backendProtocol),
      restartPolicy: app.restartPolicy,
      exposedPorts: app.exposedPorts,
      envContent: options.includeEnvVars ? app.envContent : null,
      sortOrder: app.sortOrder,
      volumes: (app.volumes || []).map((v) => ({
        name: v.name,
        mountPath: v.mountPath,
        persistent: v.persistent ?? false,
      })),
    }));

  return {
    sourceInstanceId: await getInstanceId(),
    project: {
      name: project.name,
      displayName: project.displayName,
      description: project.description,
      color: project.color,
    },
    apps: appBundles,
    gitRef: options.gitRef ?? null,
    transferType: options.transferType,
  };
}

// ---------------------------------------------------------------------------
// Import: create project + apps from a received bundle
// ---------------------------------------------------------------------------

/**
 * Import a project bundle received from another instance.
 *
 * For promote/pull: finds existing project by name within the org, updates
 * apps if they exist (by name), creates if they don't.
 * For clone: always creates new project and apps with unique names.
 *
 * All operations run in a transaction — partial failures roll back cleanly.
 */
export async function importProjectBundle(
  orgId: string,
  bundle: ProjectBundle,
  environment: string
): Promise<{ projectId: string; appIds: string[] }> {
  return db.transaction(async (tx) => {
    const isClone = bundle.transferType === "clone";

    // Find existing project in this org by name (scoped to org)
    const existing = isClone
      ? null
      : await tx.query.projects.findFirst({
          where: (p, { and, eq: e }) =>
            and(e(p.organizationId, orgId), e(p.name, bundle.project.name)),
        });

    const projectId = existing?.id ?? nanoid();

    if (!existing) {
      await tx.insert(projects).values({
        id: projectId,
        organizationId: orgId,
        name: isClone
          ? `${bundle.project.name}-clone-${nanoid(6)}`
          : bundle.project.name,
        displayName: bundle.project.displayName,
        description: bundle.project.description,
        color: bundle.project.color,
      });
    }

    // Create or update apps
    const appIds: string[] = [];
    for (const appBundle of bundle.apps) {
      // For non-clone transfers, check if app already exists in this project
      const existingApp = isClone
        ? null
        : await tx.query.apps.findFirst({
            where: (a, { and, eq: e }) =>
              and(e(a.projectId, projectId), e(a.name, appBundle.name)),
          });

      if (existingApp) {
        // Update existing app
        appIds.push(existingApp.id);
        await tx
          .update(apps)
          .set({
            composeContent: appBundle.composeContent,
            gitUrl: appBundle.gitUrl,
            gitBranch: appBundle.gitBranch,
            imageName: appBundle.imageName,
            envContent: appBundle.envContent,
            updatedAt: new Date(),
          })
          .where(eq(apps.id, existingApp.id));
      } else {
        // Create new app
        const appId = nanoid();
        appIds.push(appId);

        await tx.insert(apps).values({
          id: appId,
          organizationId: orgId,
          projectId,
          name: isClone ? `${appBundle.name}-${nanoid(6)}` : appBundle.name,
          displayName: appBundle.displayName,
          description: appBundle.description,
          source: appBundle.source,
          deployType: appBundle.deployType,
          gitUrl: appBundle.gitUrl,
          gitBranch: appBundle.gitBranch,
          imageName: appBundle.imageName,
          composeContent: appBundle.composeContent,
          composeFilePath: appBundle.composeFilePath,
          rootDirectory: appBundle.rootDirectory,
          autoTraefikLabels: appBundle.autoTraefikLabels,
          containerPort: appBundle.containerPort,
          backendProtocol: appBundle.backendProtocol ?? null,
          restartPolicy: appBundle.restartPolicy,
          exposedPorts: appBundle.exposedPorts,
          envContent: appBundle.envContent,
          sortOrder: appBundle.sortOrder,
          status: "stopped",
        });

        // Create volume records for new apps
        for (const vol of appBundle.volumes) {
          await tx.insert(volumes).values({
            id: nanoid(),
            appId,
            organizationId: orgId,
            name: vol.name,
            mountPath: vol.mountPath,
            persistent: vol.persistent,
          });
        }
      }
    }

    // Record the deployment in project_instances
    const composeSnapshot = bundle.apps
      .map((a) => a.composeContent)
      .filter(Boolean)
      .join("\n---\n");

    await tx.insert(projectInstances).values({
      id: nanoid(),
      projectId,
      meshPeerId: null, // local instance
      environment,
      gitRef: bundle.gitRef,
      composeContent: composeSnapshot || null,
      sourceInstanceId: bundle.sourceInstanceId,
      transferredAt: new Date(),
      status: "stopped",
    });

    return { projectId, appIds };
  });
}
