import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { requireAppAdmin } from "@/lib/auth/admin";
import { requirePlugin } from "@/lib/api/require-plugin";
import { db } from "@/lib/db";
import { apps, environments, domains, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getContainerDetail, hasAtFileTraefikLabels, isLocalImage } from "@/lib/docker/discover";
import { resolveContainerPort } from "@/lib/docker/resolve-port";
import { volumeNameFromMount } from "@/lib/docker/client";
import { generateComposeFromContainer, injectTraefikLabels, composeToYaml } from "@/lib/docker/compose";
import { encrypt } from "@/lib/crypto/encrypt";
import { getSslConfig, getDefaultCertResolver } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";
import { createDeployment } from "@/lib/docker/deploy";
import {
  resolveProjectForImport,
  runAsyncContainerMigration,
} from "@/lib/docker/import";
import { getPgConstraint, isUniqueViolation } from "@/lib/api/error-response";
import { APP_NAME_TAKEN_ERROR, isTopLevelAppNameTaken } from "@/lib/db/app-name";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { enrollQuietly } from "@/lib/backups/enroll";

type RouteParams = {
  params: Promise<{ orgId: string; containerId: string }>;
};

const importSchema = z.object({
  projectId: z.string().optional(),
  newProjectName: z.string().min(1).max(255).optional(),
  displayName: z.string().min(1, "Display name is required").max(255),
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens"),
  envVars: z
    .array(
      z.object({
        key: z
          .string()
          .min(1)
          .max(256, "Env key too long")
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Invalid env key"),
        value: z
          .string()
          .max(65536, "Env value too long")
          .refine((v) => !/[\x00-\x1f\x7f]/.test(v), "Value can't contain control characters"),
      })
    )
    .max(500, "Too many environment variables")
    .default([]),
  // Container paths to import; empty imports none. Omitted falls back to importVolumes.
  selectedMountDestinations: z.array(z.string().max(4096, "Mount destination too long")).max(100, "Too many mount destinations").optional(),
  // Deprecated: use selectedMountDestinations.
  importVolumes: z.boolean().default(true),
  // Port to use when none can be detected.
  containerPort: z.number().int().min(1).max(65535).optional(),
}).refine(
  (data) => !!data.projectId || !!data.newProjectName,
  { message: "Either projectId or newProjectName is required", path: ["projectId"] }
);

// POST /api/v1/organizations/[orgId]/discover/containers/[containerId]/import
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, containerId } = await params;

    const org = await verifyOrgAccess(orgId, "app.import");
    if (!org) return apiError.forbidden();
    await requireAppAdmin();

    const gate = await requirePlugin("container-import");
    if (gate) return gate;

    if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
      return NextResponse.json({ error: "Invalid container ID" }, { status: 400 });
    }

    const body = await request.json();
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const data = parsed.data;

    const existing = await db.query.apps.findFirst({
      where: and(
        eq(apps.organizationId, orgId),
        eq(apps.importedContainerId, containerId)
      ),
      columns: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Container already imported", appId: existing.id },
        { status: 409 }
      );
    }

    if (await isTopLevelAppNameTaken(data.name)) {
      return NextResponse.json({ error: APP_NAME_TAKEN_ERROR }, { status: 409 });
    }

    const detail = await getContainerDetail(containerId);
    if (!detail) {
      return NextResponse.json(
        { error: "Container not found or is Vardo-managed" },
        { status: 404 }
      );
    }

    // Port priority: Traefik label, first exposed port, user-supplied, null.
    const containerPort = resolveContainerPort(detail, data.containerPort);

    const selectedDests =
      data.selectedMountDestinations !== undefined
        ? new Set(data.selectedMountDestinations)
        : data.importVolumes
          ? null // null = all mounts
          : new Set<string>(); // empty = no mounts

    const mountsToImport =
      selectedDests === null
        ? detail.mounts
        : detail.mounts.filter((m) => selectedDests.has(m.destination));

    let compose = generateComposeFromContainer(data.name, {
      image: detail.image,
      ports: detail.ports,
      mounts: mountsToImport,
      networkMode: detail.networkMode,
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
      hasEnvVars: data.envVars.length > 0,
    });

    // TODO: if container import ever produces multi-service or host-network compose files,
    // pass serviceName here (the first bridge-network service) as deploy.ts does.
    const sslConfig = await getSslConfig();
    if (detail.domain && containerPort) {
      compose = injectTraefikLabels(compose, {
        projectName: data.name,
        domain: detail.domain,
        containerPort,
        certResolver: getDefaultCertResolver(sslConfig),
      });
    }

    // Lets the deploy engine rebuild serversTransport for HTTPS backends.
    let importedBackendProtocol: "http" | "https" | null = null;
    const schemeLabel = Object.entries(detail.labels).find(
      ([k]) => /^traefik\.http\.services\..+\.loadbalancer\.server\.scheme$/.test(k)
    )?.[1];
    if (schemeLabel === "https") {
      importedBackendProtocol = "https";
    } else if (containerPort && (containerPort === 443 || containerPort === 8443)) {
      importedBackendProtocol = "https";
    }

    const composeContent = composeToYaml(compose);

    let envContent: string | null = null;
    if (data.envVars.length > 0) {
      const envLines = data.envVars.map(({ key, value }) => `${key}=${value}`).join("\n");
      envContent = encrypt(envLines, orgId);
    }

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
            source: "direct",
            deployType: "image",
            imageName: detail.image,
            composeContent,
            containerPort: containerPort ?? undefined,
            backendProtocol: importedBackendProtocol,
            autoTraefikLabels: false,
            projectId: resolvedProjectId,
            envContent,
            importedContainerId: containerId,
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

        if (detail.domain && containerPort) {
          await tx.insert(domains).values({
            id: nanoid(),
            appId,
            domain: detail.domain,
            port: containerPort,
            certResolver: getDefaultCertResolver(sslConfig),
            isPrimary: true,
          });
        }

        if (mountsToImport.length > 0) {
          for (const mount of mountsToImport) {
            await tx.insert(volumes).values({
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
        }

        return { app };
      });
    } catch (txError) {
      if (txError instanceof Error && txError.message === "PROJECT_NOT_FOUND") {
        return NextResponse.json({ error: "Project not found" }, { status: 400 });
      }
      throw txError;
    }

    const { app } = result;
    const appId = app.id;

    // Imported mounts hold existing data, so sizes are measured off the request.
    void enrollQuietly({ appId, appName: app.name, organizationId: orgId, measure: true });

    const warnings: string[] = [];

    if (detail.networkMode === "host") {
      warnings.push(
        "This container uses host networking — no port mapping or automatic domain routing is available."
      );
    }

    if (isLocalImage(detail.image)) {
      warnings.push(
        "This image may not be pullable from a registry — Vardo won't be able to redeploy without pushing to a registry first."
      );
    }

    const bindMounts = mountsToImport.filter((m) => m.type === "bind");
    if (bindMounts.length > 0) {
      warnings.push(
        `${bindMounts.length} bind mount(s) reference host paths — they've been imported but Vardo won't manage the data.`
      );
    }

    if (hasAtFileTraefikLabels(detail.labels)) {
      warnings.push(
        "One or more Traefik labels reference external @file provider configs — make sure those configurations exist in your Traefik setup."
      );
    }

    recordActivity({
      organizationId: orgId,
      action: "app.imported",
      appId,
      userId: org.session.user.id,
      metadata: {
        name: data.name,
        displayName: data.displayName,
        containerId,
        image: detail.image,
      },
    });

    // The client polls this deployment ID while the migration runs async.
    // On deploy failure the original container restarts.

    const deploymentId = await createDeployment({
      appId,
      organizationId: orgId,
      trigger: "api",
      triggeredBy: org.session.user.id,
    });

    runAsyncContainerMigration({
      containerIds: [containerId],
      appId,
      deploymentId,
      orgId,
      userId: org.session.user.id,
      displayName: data.displayName,
      activityMetadata: { containerId, source: "import" },
      // The original container would still hold its ports.
      bailOnFirstStopFailure: true,
    });

    return NextResponse.json({ app, warnings, deploymentId, migrated: false }, { status: 201 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      if (getPgConstraint(error) === "app_imported_container_uniq") {
        return NextResponse.json(
          { error: "This container has already been imported" },
          { status: 409 }
        );
      }
      return NextResponse.json({ error: APP_NAME_TAKEN_ERROR }, { status: 409 });
    }
    return handleRouteError(error, "Error importing container");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "containers-import" });
