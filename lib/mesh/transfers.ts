import { db } from "@/lib/db";
import { apps, projects, projectInstances, volumes } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getInstanceId } from "@/lib/constants";
import { narrowBackendProtocol } from "@/lib/docker/compose";
import { decrypt, decryptOrFallback, encrypt, isEncrypted } from "@/lib/crypto/encrypt";

/** Volume transfers need the backup engine. */
export async function canTransferVolumes(): Promise<boolean> {
  const { isFeatureEnabledAsync } = await import("@/lib/config/features");
  return isFeatureEnabledAsync("backups");
}

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
  envContent: string | null; // plaintext; only included if explicitly requested
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

/** Build a project bundle: metadata, app configs and optionally env vars. */
export async function buildProjectBundle(
  projectId: string,
  options: {
    transferType: "promote" | "pull" | "clone";
    includeEnvVars?: boolean;
    gitRef?: string | null;
    /** Limits the lookup to one org. */
    organizationId?: string;
  }
): Promise<ProjectBundle> {
  const project = await db.query.projects.findFirst({
    where: options.organizationId
      ? and(eq(projects.id, projectId), eq(projects.organizationId, options.organizationId))
      : eq(projects.id, projectId),
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

  // Ciphertext is keyed to this instance and org, so the bundle carries plaintext.
  const exportEnv = (app: { name: string; envContent: string | null }): string | null => {
    if (!options.includeEnvVars || !app.envContent) return null;
    const { content, decryptFailed } = decryptOrFallback(app.envContent, project.organizationId);
    if (decryptFailed) throw new Error(`Env vars for "${app.name}" cannot be decrypted`);
    return content;
  };

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
      envContent: exportEnv(app),
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

/** A bundle this instance won't import as sent. */
export class BundleRejectedError extends Error {}

const BUNDLE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Names become directories under the apps root, so they get the create-time rules. */
function assertBundleNames(bundle: ProjectBundle) {
  const names = [bundle.project.name, ...bundle.apps.map((a) => a.name)];
  const bad = names.find((n) => !BUNDLE_NAME_RE.test(n));
  if (bad !== undefined) {
    throw new BundleRejectedError(`Invalid name in bundle: ${JSON.stringify(bad)}`);
  }
}

/** Bundle env as stored in `orgId`: encrypted under its key, or null when empty. */
export function sealBundleEnv(appName: string, envContent: string | null, orgId: string): string | null {
  if (!envContent?.trim()) return null;
  if (!isEncrypted(envContent)) return encrypt(envContent, orgId);
  try {
    // Only readable when it came from this same instance and org.
    return encrypt(decrypt(envContent, orgId), orgId);
  } catch {
    throw new BundleRejectedError(
      `Env vars for "${appName}" are encrypted with another instance's key; resend from an updated peer`,
    );
  }
}

/**
 * Import a project bundle in one transaction.
 * Promote and pull update apps by name; clone always creates new ones.
 */
export async function importProjectBundle(
  orgId: string,
  bundle: ProjectBundle,
  environment: string
): Promise<{ projectId: string; appIds: string[] }> {
  assertBundleNames(bundle);
  return db.transaction(async (tx) => {
    const isClone = bundle.transferType === "clone";

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

    const appIds: string[] = [];
    for (const appBundle of bundle.apps) {
      // Clones start without env.
      const envContent = isClone ? null : sealBundleEnv(appBundle.name, appBundle.envContent, orgId);

      const existingApp = isClone
        ? null
        : await tx.query.apps.findFirst({
            where: (a, { and, eq: e }) =>
              and(e(a.organizationId, orgId), e(a.projectId, projectId), e(a.name, appBundle.name)),
          });

      if (existingApp) {
        appIds.push(existingApp.id);
        await tx
          .update(apps)
          .set({
            composeContent: appBundle.composeContent,
            gitUrl: appBundle.gitUrl,
            gitBranch: appBundle.gitBranch,
            imageName: appBundle.imageName,
            // A bundle sent without env leaves the destination's env alone.
            ...(envContent !== null ? { envContent } : {}),
            updatedAt: new Date(),
          })
          .where(eq(apps.id, existingApp.id));
      } else {
        const appId = nanoid();
        appIds.push(appId);

        const appName = isClone
          ? `${appBundle.name}-${nanoid(6)}`
          : appBundle.name;

        // Top-level app names are unique instance-wide, so another org's app blocks the transfer.
        const nameTaken = await tx.query.apps.findFirst({
          where: (a, { and, eq: e, isNull: n }) =>
            and(e(a.name, appName), n(a.parentAppId)),
          columns: { id: true },
        });
        if (nameTaken) {
          throw new BundleRejectedError(
            `App name "${appName}" is already taken on this instance`
          );
        }

        await tx.insert(apps).values({
          id: appId,
          organizationId: orgId,
          projectId,
          name: appName,
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
          envContent,
          sortOrder: appBundle.sortOrder,
          status: "stopped",
        });

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

    const composeSnapshot = bundle.apps
      .map((a) => a.composeContent)
      .filter(Boolean)
      .join("\n---\n");

    await tx.insert(projectInstances).values({
      id: nanoid(),
      projectId,
      meshPeerId: null,
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
