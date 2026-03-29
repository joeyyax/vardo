import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps, domains, environments, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { discoverContainers, getContainerDetail, isLocalImage } from "@/lib/docker/discover";
import { slugify } from "@/lib/ui/slugify";
import {
  generateComposeFromContainer,
  injectTraefikLabels,
  composeToYaml,
} from "@/lib/docker/compose";
import type { ComposeFile } from "@/lib/docker/compose";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";
import { createDeployment } from "@/lib/docker/deploy";
import {
  resolveProjectForImport,
  getPgErrorCode,
  runAsyncContainerMigration,
  parseContainerEnvVars,
} from "@/lib/docker/import";

type RouteParams = {
  params: Promise<{ orgId: string; composeProject: string }>;
};

const importGroupSchema = z.object({
  projectId: z.string().nullable().optional(),
  newProjectName: z.string().min(1).max(255).optional(),
  displayName: z.string().min(1, "Display name is required").max(255),
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens"),
});

// POST /api/v1/organizations/[orgId]/discover/groups/[composeProject]/import
async function handler(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, composeProject } = await params;

    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Validate composeProject — only allow safe identifiers
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(composeProject)) {
      return NextResponse.json({ error: "Invalid compose project name" }, { status: 400 });
    }

    const body = await request.json();
    const parsed = importGroupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const data = parsed.data;

    // Guard against re-importing a group that already has an app with this slug.
    // The unique constraint catches this at DB level too, but an explicit check
    // here gives a better error and avoids unnecessary container inspection work.
    const existingApp = await db.query.apps.findFirst({
      where: and(eq(apps.organizationId, orgId), eq(apps.name, data.name)),
      columns: { id: true },
    });
    if (existingApp) {
      return NextResponse.json(
        { error: "An app with this slug already exists in this organization", appId: existingApp.id },
        { status: 409 }
      );
    }

    // Discover all unmanaged containers and find those in this compose group
    const discovery = await discoverContainers();
    const group = discovery.groups.find((g) => g.composeProject === composeProject);
    if (!group || group.containers.length === 0) {
      return NextResponse.json(
        { error: "Compose group not found or already managed" },
        { status: 404 }
      );
    }

    // Inspect each container for full detail (env, mounts, labels, etc.)
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

    const sslConfig = await getSslConfig();
    const certResolver = getPrimaryIssuer(sslConfig);

    // Build a multi-service compose file by merging individual container configs.
    // Use the com.docker.compose.service label as the service name, falling back
    // to the container name slugified.
    //
    // Domain detection: each service may already carry Traefik routing labels
    // (preserved via ALLOWED_LABEL_PREFIXES in generateComposeFromContainer).
    // For services that have a detectable domain + container port but no existing
    // Traefik labels, we inject them so Vardo-managed deploys keep the routing.
    // autoTraefikLabels is set to false on the app record because the Traefik
    // config is captured in the compose content rather than generated at deploy time.
    const merged: ComposeFile = { services: {} };

    // Collect per-service domain info for DB records (created after insert).
    type ServiceDomain = { serviceName: string; domain: string; port: number };
    const serviceDomains: ServiceDomain[] = [];

    // Collect all mounts across services for volume DB records.
    type ServiceMount = { appId: string; mount: { name: string; source: string; destination: string; type: string } };
    const allMounts: Omit<ServiceMount, "appId">["mount"][] = [];

    const warnings: string[] = [];

    for (const detail of validDetails) {
      const serviceName =
        (detail.labels["com.docker.compose.service"] ?? slugify(detail.name)) || slugify(detail.name);

      // Parse env vars from the running container. Values containing ${...} are
      // skipped to avoid Docker Compose variable substitution breaking the file.
      const { vars: envVars, skippedKeys } = parseContainerEnvVars(detail.env);
      if (skippedKeys.length > 0) {
        warnings.push(
          `Service "${serviceName}": ${skippedKeys.length} env var(s) skipped (values contain \${...} interpolation syntax): ${skippedKeys.join(", ")}`
        );
      }

      const singleFile = generateComposeFromContainer(serviceName, {
        image: detail.image,
        ports: detail.ports,
        mounts: detail.mounts,
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
        // Env vars are inlined in the environment: block. Group compose imports
        // use the environment: key directly rather than an env_file because each
        // service has its own vars and multi-service env file routing is not yet
        // supported. hasEnvVars controls the env_file directive only.
        hasEnvVars: false,
      });

      // Inline env vars for this service directly in the compose.
      const composeSvc = singleFile.services[serviceName];
      if (composeSvc && Object.keys(envVars).length > 0) {
        composeSvc.environment = envVars;
      }

      // Inject Traefik labels for services that have a detectable domain but no
      // existing Traefik router labels. Services that already carry traefik.*
      // labels (preserved from the original container) keep their own config.
      const hasExistingTraefikRouter = Object.keys(detail.labels).some(
        (k) => /^traefik\.http\.routers\..+\.rule$/.test(k)
      );
      const containerPort =
        detail.containerPort ??
        detail.ports.find((p) => p.internal)?.internal ??
        null;

      if (detail.domain && containerPort && !hasExistingTraefikRouter) {
        const injected = injectTraefikLabels(singleFile, {
          projectName: `${data.name}-${serviceName}`,
          domain: detail.domain,
          containerPort,
          serviceName,
          certResolver,
        });
        // Merge labels back so the rest of the loop picks them up
        singleFile.services[serviceName] = injected.services[serviceName];
      }

      if (detail.domain && containerPort) {
        serviceDomains.push({ serviceName, domain: detail.domain, port: containerPort });
      }

      // Merge this service into the combined file
      for (const [name, mergedSvc] of Object.entries(singleFile.services)) {
        merged.services[name] = mergedSvc;
      }

      // Merge named volume declarations
      if (singleFile.volumes) {
        merged.volumes ??= {};
        for (const [volName, volDef] of Object.entries(singleFile.volumes)) {
          merged.volumes[volName] = volDef;
        }
      }

      // Accumulate mounts for volume DB records
      for (const mount of detail.mounts) {
        allMounts.push(mount);
      }
    }

    const composeContent = composeToYaml(merged);

    let result: { app: (typeof apps)["$inferSelect"] };
    try {
      result = await db.transaction(async (tx) => {
        // Resolve projectId — create new project if requested
        const resolvedProjectId = await resolveProjectForImport(
          tx,
          orgId,
          data.projectId,
          data.newProjectName,
        );

        // Insert parent app record for the compose stack
        const appId = nanoid();
        const [app] = await tx
          .insert(apps)
          .values({
            id: appId,
            organizationId: orgId,
            name: data.name,
            displayName: data.displayName,
            source: "direct",
            deployType: "compose",
            composeContent,
            // autoTraefikLabels is false — Traefik config is baked into the
            // compose content either from the original container labels or via
            // explicit injectTraefikLabels above. Regenerating at deploy time
            // would overwrite service-specific routing configs.
            autoTraefikLabels: false,
            projectId: resolvedProjectId,
            status: "active",
          })
          .returning();

        // Auto-create production environment
        await tx.insert(environments).values({
          id: nanoid(),
          appId,
          name: "production",
          type: "production",
          isDefault: true,
        });

        // Create domain records for services where a domain was detected.
        // These appear in the Vardo UI and are used for TLS cert tracking.
        for (const sd of serviceDomains) {
          await tx.insert(domains).values({
            id: nanoid(),
            appId,
            domain: sd.domain,
            port: sd.port,
            certResolver,
            isPrimary: serviceDomains.indexOf(sd) === 0,
          });
        }

        // Create volume records for all mounts across all services.
        // Deduplicate by mountPath to avoid unique-constraint violations when
        // multiple services share the same host path.
        const seenMountPaths = new Set<string>();
        for (const mount of allMounts) {
          if (seenMountPaths.has(mount.destination)) continue;
          seenMountPaths.add(mount.destination);
          await tx.insert(volumes).values({
            id: nanoid(),
            appId,
            organizationId: orgId,
            name: mount.source || mount.destination.replace(/\//g, "-").replace(/^-/, ""),
            mountPath: mount.destination,
            type: mount.type === "bind" ? "bind" : "named",
            source: mount.source || null,
            // Bind mounts are flagged as non-persistent — Vardo can't manage host paths
            persistent: mount.type !== "bind",
          });
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

    // Warn about local images and host networking
    for (const detail of validDetails) {
      const svcName =
        (detail.labels["com.docker.compose.service"] ?? slugify(detail.name)) || slugify(detail.name);
      if (isLocalImage(detail.image)) {
        warnings.push(
          `Service "${svcName}" uses a local image — Vardo won't be able to redeploy without pushing to a registry first.`
        );
      }
      if (detail.networkMode === "host") {
        warnings.push(
          `Service "${svcName}" uses host networking — no port mapping or automatic domain routing is available.`
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
      },
    });

    // Pre-create deployment record, then migrate async
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

    return NextResponse.json({ app, warnings, deploymentId, migrated: false }, { status: 201 });
  } catch (error) {
    const pgCode = getPgErrorCode(error);
    if (pgCode === "23505") {
      return NextResponse.json(
        { error: "An app with this slug already exists in this organization" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error importing compose group");
  }
}

export const POST = withRateLimit(handler, { tier: "mutation", key: "discover-import" });
