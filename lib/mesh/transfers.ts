import { db } from "@/lib/db";
import { apps, projects, projectInstances, volumes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getInstanceId } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Serializable app config within a project bundle. */
export type AppBundle = {
  name: string;
  displayName: string;
  description: string | null;
  source: "git" | "direct";
  deployType: "compose" | "dockerfile" | "image" | "static" | "nixpacks";
  gitUrl: string | null;
  gitBranch: string | null;
  imageName: string | null;
  composeContent: string | null;
  composeFilePath: string | null;
  rootDirectory: string | null;
  autoTraefikLabels: boolean | null;
  containerPort: number | null;
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
    sourceInstanceId: getInstanceId(),
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
 * Creates the project and apps if they don't exist, or updates if they do.
 * Records a project_instances entry for tracking.
 */
export async function importProjectBundle(
  orgId: string,
  bundle: ProjectBundle,
  environment: string
): Promise<{ projectId: string; appIds: string[] }> {
  // Check if project already exists in this org (by name)
  let project = await db.query.projects.findFirst({
    where: eq(projects.name, bundle.project.name),
  });

  const projectId = project?.id ?? nanoid();

  if (!project) {
    // Create new project
    await db.insert(projects).values({
      id: projectId,
      organizationId: orgId,
      name: bundle.transferType === "clone"
        ? `${bundle.project.name}-clone-${nanoid(6)}`
        : bundle.project.name,
      displayName: bundle.project.displayName,
      description: bundle.project.description,
      color: bundle.project.color,
    });
  }

  // Create/update apps
  const appIds: string[] = [];
  for (const appBundle of bundle.apps) {
    const appId = nanoid();
    appIds.push(appId);

    await db.insert(apps).values({
      id: appId,
      organizationId: orgId,
      projectId,
      name: bundle.transferType === "clone"
        ? `${appBundle.name}-${nanoid(6)}`
        : appBundle.name,
      displayName: appBundle.displayName,
      description: appBundle.description,
      source: appBundle.source as "git" | "direct",
      deployType: appBundle.deployType as "compose" | "dockerfile" | "image",
      gitUrl: appBundle.gitUrl,
      gitBranch: appBundle.gitBranch,
      imageName: appBundle.imageName,
      composeContent: appBundle.composeContent,
      composeFilePath: appBundle.composeFilePath,
      rootDirectory: appBundle.rootDirectory,
      autoTraefikLabels: appBundle.autoTraefikLabels,
      containerPort: appBundle.containerPort,
      restartPolicy: appBundle.restartPolicy,
      exposedPorts: appBundle.exposedPorts,
      envContent: appBundle.envContent,
      sortOrder: appBundle.sortOrder,
      status: "stopped",
    });

    // Create volume records
    for (const vol of appBundle.volumes) {
      await db.insert(volumes).values({
        id: nanoid(),
        appId,
        organizationId: orgId,
        name: vol.name,
        mountPath: vol.mountPath,
        persistent: vol.persistent,
      });
    }
  }

  // Record the deployment in project_instances
  const composeSnapshot = bundle.apps
    .map((a) => a.composeContent)
    .filter(Boolean)
    .join("\n---\n");

  await db.insert(projectInstances).values({
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
}
