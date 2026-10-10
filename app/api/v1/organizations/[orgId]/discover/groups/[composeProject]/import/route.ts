import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requireAppAdmin } from "@/lib/auth/admin";
import { requirePlugin } from "@/lib/api/require-plugin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps, domains, environments, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { formatEnvVar } from "@/lib/env/dotenv";
import { z } from "zod";
import { discoverContainers, getContainerDetail, hasAtFileTraefikLabels, isLocalImage } from "@/lib/docker/discover";
import { slugify } from "@/lib/ui/slugify";
import { volumeNameFromMount } from "@/lib/docker/client";
import {
  generateComposeFromContainer,
  injectTraefikLabels,
  composeToYaml,
} from "@/lib/docker/compose";
import type { ComposeFile } from "@/lib/docker/compose";
import { getSslConfig, getDefaultCertResolver } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";
import { createDeployment } from "@/lib/docker/deploy";
import { encrypt } from "@/lib/crypto/encrypt";
import { gitUrlColumns } from "@/lib/api/git-credentials";
import { readableApp } from "@/lib/api/readable-app";
import {
  resolveProjectForImport,
  runAsyncContainerMigration,
  parseContainerEnvVars,
  isSensitiveEnvKey,
  parseComposeDependsOn,
  isComposeProjectNetwork,
  mergeComposeFile,
  detectGitBuildContext,
} from "@/lib/docker/import";
import { isUniqueViolation } from "@/lib/api/error-response";
import { APP_NAME_TAKEN_ERROR, isTopLevelAppNameTaken } from "@/lib/db/app-name";
import { enrollQuietly } from "@/lib/backups/enroll";
import { armInitialBackupQuietly } from "@/lib/backups/initial-backup";

type RouteParams = {
  params: Promise<{ orgId: string; composeProject: string }>;
};

const importGroupSchema = z.object({
  projectId: z.string().optional(),
  newProjectName: z.string().min(1).max(255).optional(),
  displayName: z.string().min(1, "Display name is required").max(255),
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens"),
  // Git URL for stacks that build from source.
  gitUrl: z.string().url().optional(),
  gitBranch: z.string().max(255).optional(),
}).refine(
  (data) => !!data.projectId || !!data.newProjectName,
  { message: "Either projectId or newProjectName is required", path: ["projectId"] }
);

// POST /api/v1/organizations/[orgId]/discover/groups/[composeProject]/import
async function handler(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, composeProject } = await params;

    const org = await verifyOrgAccess(orgId, "app.import");
    if (!org) return apiError.forbidden();
    await requireAppAdmin();

    const gate = await requirePlugin("container-import");
    if (gate) return gate;

    // Only safe identifiers.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(composeProject)) {
      return NextResponse.json({ error: "Invalid compose project name" }, { status: 400 });
    }

    const body = await request.json();
    const parsed = importGroupSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const data = parsed.data;

    // Blocks re-importing by compose project or slug. Unique constraints catch races.
    const existingByGroup = await db.query.apps.findFirst({
      where: and(
        eq(apps.organizationId, orgId),
        eq(apps.importedComposeProject, composeProject)
      ),
      columns: { id: true },
    });
    if (existingByGroup) {
      return NextResponse.json(
        { error: "This compose group has already been imported", appId: existingByGroup.id },
        { status: 409 }
      );
    }

    // An app held by another org must stay invisible.
    const existingBySlug = await db.query.apps.findFirst({
      where: and(eq(apps.organizationId, orgId), eq(apps.name, data.name)),
      columns: { id: true },
    });
    if (existingBySlug) {
      return NextResponse.json(
        { error: APP_NAME_TAKEN_ERROR, appId: existingBySlug.id },
        { status: 409 }
      );
    }
    if (await isTopLevelAppNameTaken(data.name)) {
      return NextResponse.json({ error: APP_NAME_TAKEN_ERROR }, { status: 409 });
    }

    const discovery = await discoverContainers();
    const group = discovery.groups.find((g) => g.composeProject === composeProject);
    if (!group || group.containers.length === 0) {
      return NextResponse.json(
        { error: "Compose group not found or already managed" },
        { status: 404 }
      );
    }

    const details = await Promise.all(
      group.containers.map((c) => getContainerDetail(c.id))
    );

    const validDetails = details.filter((d) => d !== null);
    if (validDetails.length === 0) {
      return NextResponse.json(
        { error: "No importable containers found in this compose group" },
        { status: 404 }
      );
    }

    // Detects the git URL from container labels when none is given.
    let effectiveGitUrl = data.gitUrl;
    let effectiveGitBranch = data.gitBranch;
    let autoDetectedGit = false;
    if (!effectiveGitUrl) {
      const firstContainer = validDetails[0];
      const workingDir = firstContainer.labels["com.docker.compose.project.working_dir"];
      const configFiles = firstContainer.labels["com.docker.compose.project.config_files"];
      if (workingDir && configFiles) {
        const gitContext = await detectGitBuildContext(workingDir, configFiles);
        if (gitContext?.gitUrl && gitContext.hasBuildDirectives) {
          effectiveGitUrl = gitContext.gitUrl;
          effectiveGitBranch = gitContext.gitBranch ?? undefined;
          autoDetectedGit = true;
        }
      }
    }

    const sslConfig = await getSslConfig();
    const certResolver = getDefaultCertResolver(sslConfig);

    // Merges each container into one compose file, keyed by service label or slugified name.
    const merged: ComposeFile = { services: {} };

    type ServiceDomain = { serviceName: string; domain: string; port: number };
    const serviceDomains: ServiceDomain[] = [];

    type ServiceMount = { appId: string; mount: { name: string; source: string; destination: string; type: string } };
    const allMounts: Omit<ServiceMount, "appId">["mount"][] = [];

    // Sensitive vars from every service share one encrypted .env. The last duplicate key wins.
    const allSensitiveVars: Record<string, string> = {};

    const warnings: string[] = [];

    for (const detail of validDetails) {
      const serviceName =
        (detail.labels["com.docker.compose.service"] ?? slugify(detail.name)) || slugify(detail.name);

      // Skips values containing ${...}, which Compose would substitute.
      const { vars: envVars, skippedKeys } = parseContainerEnvVars(detail.env);
      if (skippedKeys.length > 0) {
        warnings.push(
          `Service "${serviceName}": ${skippedKeys.length} env var(s) skipped (values contain \${...} interpolation syntax): ${skippedKeys.join(", ")}`
        );
      }

      // Sensitive vars go to the encrypted .env; the rest inline.
      const publicVars: Record<string, string> = {};
      const sensitiveVars: Record<string, string> = {};
      for (const [k, v] of Object.entries(envVars)) {
        if (isSensitiveEnvKey(k)) {
          sensitiveVars[k] = v;
        } else {
          publicVars[k] = v;
        }
      }
      Object.assign(allSensitiveVars, sensitiveVars);

      // Drops the old project's default network; the new compose creates its own.
      const effectiveNetworkMode = isComposeProjectNetwork(detail.networkMode, composeProject)
        ? ""
        : detail.networkMode;

      const singleFile = generateComposeFromContainer(serviceName, {
        image: detail.image,
        ports: detail.ports,
        mounts: detail.mounts,
        networkMode: effectiveNetworkMode,
        restartPolicy: detail.restartPolicy,
        capAdd: detail.capAdd,
        capDrop: detail.capDrop,
        devices: detail.devices,
        privileged: detail.privileged,
        securityOpt: detail.securityOpt,
        shmSize: detail.shmSize,
        init: detail.init,
        extraHosts: detail.extraHosts,
        nanoCpus: detail.nanoCpus,
        memoryBytes: detail.memoryBytes,
        ulimits: detail.ulimits,
        tmpfs: detail.tmpfs,
        hostname: detail.hostname,
        user: detail.user,
        stopSignal: detail.stopSignal,
        healthcheck: detail.healthcheck,
        entrypoint: detail.entrypoint,
        command: detail.command,
        labels: detail.labels,
        // Adds env_file: [".env"] for services with sensitive vars.
        hasEnvVars: Object.keys(sensitiveVars).length > 0,
      });

      // Rebuilds depends_on, health conditions included, from com.docker.compose.depends_on.
      const dependsOn = parseComposeDependsOn(detail.labels);
      if (Object.keys(dependsOn).length > 0) {
        singleFile.services[serviceName].depends_on = dependsOn;
      }

      const composeSvc = singleFile.services[serviceName];
      if (composeSvc && Object.keys(publicVars).length > 0) {
        composeSvc.environment = publicVars;
      }

      // Services with their own traefik.* labels keep them.
      const hasExistingTraefikRouter = Object.keys(detail.labels).some(
        (k) => /^traefik\.http\.routers\..+\.rule$/.test(k)
      );
      const containerPort = detail.containerPort;

      if (detail.domain && containerPort && !hasExistingTraefikRouter) {
        const injected = injectTraefikLabels(singleFile, {
          projectName: `${data.name}-${serviceName}`,
          domain: detail.domain,
          containerPort,
          serviceName,
          certResolver,
        });
        singleFile.services[serviceName] = injected.services[serviceName];
      }

      if (detail.domain && containerPort) {
        serviceDomains.push({ serviceName, domain: detail.domain, port: containerPort });
      }

      // Skips the old project's default networks; they go away with the original containers.
      mergeComposeFile(merged, singleFile, composeProject);

      for (const mount of detail.mounts) {
        allMounts.push(mount);
      }
    }

    if (merged.networks && Object.keys(merged.networks).length === 0) {
      delete merged.networks;
    }

    // Deploy regenerates Traefik labels from these app fields.
    let importedContainerPort: number | null = null;
    let importedBackendProtocol: "http" | "https" | null = null;
    if (serviceDomains.length > 0) {
      importedContainerPort = serviceDomains[0].port;
    }
    for (const detail of validDetails) {
      const scheme = Object.entries(detail.labels).find(
        ([k]) => /^traefik\.http\.services\..+\.loadbalancer\.server\.scheme$/.test(k)
      )?.[1];
      if (scheme === "https") {
        importedBackendProtocol = "https";
        break;
      }
    }
    if (!importedBackendProtocol && importedContainerPort && (importedContainerPort === 443 || importedContainerPort === 8443)) {
      importedBackendProtocol = "https";
    }

    const composeContent = composeToYaml(merged);

    let envContent: string | null = null;
    if (Object.keys(allSensitiveVars).length > 0) {
      const envLines = Object.entries(allSensitiveVars)
        .map(([k, v]) => formatEnvVar(k, v))
        .join("\n");
      envContent = encrypt(envLines, orgId);
    }

    // A git URL builds from the repo; otherwise deploy uses the generated compose.
    const useGitSource = !!effectiveGitUrl;
    const gitColumns = gitUrlColumns(effectiveGitUrl, orgId);

    let result: { app: (typeof apps)["$inferSelect"] };
    try {
      result = await db.transaction(async (tx) => {
        const resolvedProjectId = await resolveProjectForImport(
          tx,
          orgId,
          data.projectId,
          data.newProjectName,
        );

        const appId = nanoid();
        const [app] = await tx
          .insert(apps)
          .values({
            id: appId,
            organizationId: orgId,
            name: data.name,
            displayName: data.displayName,
            source: useGitSource ? "git" : "direct",
            deployType: "compose",
            // Git source reads compose from the cloned repo.
            composeContent: useGitSource ? null : composeContent,
            ...gitColumns,
            gitBranch: effectiveGitBranch ?? null,
            // Traefik config lives in the compose; regenerating it would overwrite per-service routing.
            autoTraefikLabels: false,
            containerPort: importedContainerPort,
            backendProtocol: importedBackendProtocol,
            projectId: resolvedProjectId,
            envContent,
            importedComposeProject: composeProject,
            status: "active",
          })
          .returning();

        await tx.insert(environments).values({
          id: nanoid(),
          appId,
          name: "production",
          type: "production",
          isDefault: true,
        });

        // Domain records drive the UI and TLS cert tracking.
        if (serviceDomains.length > 0) {
          await tx.insert(domains).values(
            serviceDomains.map((sd, i) => ({
              id: nanoid(),
              appId,
              domain: sd.domain,
              port: sd.port,
              certResolver,
              isPrimary: i === 0,
            }))
          );
        }

        // Deduped by mountPath; services can share a host path.
        const seenMountPaths = new Set<string>();
        const volumeRows: (typeof volumes)["$inferInsert"][] = [];
        for (const mount of allMounts) {
          if (seenMountPaths.has(mount.destination)) continue;
          seenMountPaths.add(mount.destination);
          volumeRows.push({
            id: nanoid(),
            appId,
            organizationId: orgId,
            name: volumeNameFromMount(mount),
            mountPath: mount.destination,
            type: mount.type === "bind" ? "bind" : "named",
            source: mount.source || null,
            // Bind mounts aren't persistent; Vardo can't manage host paths.
            persistent: mount.type !== "bind",
          });
        }
        if (volumeRows.length > 0) {
          await tx.insert(volumes).values(volumeRows);
        }

        return { app };
      });
    } catch (txError) {
      if (txError instanceof Error && txError.message === "PROJECT_NOT_FOUND") {
        return NextResponse.json({ error: "Project not found" }, { status: 400 });
      }
      // Lost a race to another insert. Return the existing app so the client can redirect.
      if (isUniqueViolation(txError)) {
        const existing =
          (await db.query.apps.findFirst({
            where: and(eq(apps.organizationId, orgId), eq(apps.name, data.name)),
            columns: { id: true },
          })) ??
          (await db.query.apps.findFirst({
            where: and(
              eq(apps.organizationId, orgId),
              eq(apps.importedComposeProject, composeProject)
            ),
            columns: { id: true },
          }));
        return NextResponse.json(
          {
            error: APP_NAME_TAKEN_ERROR,
            ...(existing ? { appId: existing.id } : {}),
          },
          { status: 409 }
        );
      }
      throw txError;
    }

    const { app } = result;
    const appId = app.id;

    // Imported mounts hold existing data, so sizes are measured off the request.
    void enrollQuietly({ appId, appName: app.name, organizationId: orgId, measure: true }).then(() =>
      armInitialBackupQuietly(appId, "deploy"),
    );

    // Warn about local images, host networking and @file provider references
    for (const detail of validDetails) {
      const svcName =
        (detail.labels["com.docker.compose.service"] ?? slugify(detail.name)) || slugify(detail.name);
      // Git source builds local images.
      if (isLocalImage(detail.image) && !useGitSource) {
        warnings.push(
          `Service "${svcName}" uses a local image — Vardo won't be able to redeploy without pushing to a registry first.`
        );
      }
      if (detail.networkMode === "host") {
        warnings.push(
          `Service "${svcName}" uses host networking — no port mapping or automatic domain routing is available.`
        );
      }
      if (hasAtFileTraefikLabels(detail.labels)) {
        warnings.push(
          `Service "${svcName}": one or more Traefik labels reference external @file provider configs — make sure those configurations exist in your Traefik setup.`
        );
      }
    }

    recordActivity({
      organizationId: orgId,
      action: "app.imported",
      appId,
      userId: org.session.user.id,
      metadata: {
        name: data.name,
        displayName: data.displayName,
        composeProject,
        serviceCount: validDetails.length,
        ...(autoDetectedGit && { gitAutoDetected: true, gitUrl: gitColumns.gitUrl }),
      },
    });

    const deploymentId = await createDeployment({
      appId,
      organizationId: orgId,
      trigger: "api",
      triggeredBy: org.session.user.id,
    });

    const containerIds = validDetails.map((d) => d.id);

    runAsyncContainerMigration({
      containerIds,
      appId,
      deploymentId,
      orgId,
      userId: org.session.user.id,
      displayName: data.displayName,
      activityMetadata: { composeProject, source: "group-import" },
    });

    return NextResponse.json({
      app: readableApp(app, true),
      warnings,
      deploymentId,
      migrated: false,
      ...(autoDetectedGit && { gitAutoDetected: true, gitUrl: gitColumns.gitUrl }),
    }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error importing compose group");
  }
}

export const POST = withRateLimit(handler, { tier: "mutation", key: "discover-import" });
