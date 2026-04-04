import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { db } from "@/lib/db";
import { apps, domains, environments, volumes } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { discoverContainers, getContainerDetail, hasAtFileTraefikLabels, isLocalImage } from "@/lib/docker/discover";
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
import { encrypt } from "@/lib/crypto/encrypt";
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
  // Optional git URL for compose projects that need to build from source.
  // When provided, Vardo clones the repo and uses docker-compose.yml with
  // build: directives instead of pulling pre-built images.
  gitUrl: z.string().url().optional(),
  gitBranch: z.string().max(255).optional(),
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

    // Guard against re-importing the same compose group. Check both the
    // compose project name (importedComposeProject) and the requested slug
    // (name) so the client gets a useful error in both cases. Explicit checks
    // here give better errors and avoid unnecessary container inspection work;
    // the unique constraints catch any race condition at DB level.
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

    const existingBySlug = await db.query.apps.findFirst({
      where: and(eq(apps.organizationId, orgId), eq(apps.name, data.name)),
      columns: { id: true },
    });
    if (existingBySlug) {
      return NextResponse.json(
        { error: "An app with this slug already exists in this organization", appId: existingBySlug.id },
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

    // Auto-detect git URL from compose project directory if not provided.
    // Uses container labels to find the original compose file location.
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

    // Sensitive env vars collected across all services for encrypted envContent.
    // All services with sensitive vars will reference the shared .env file.
    // When multiple services define the same key with different values, the last
    // service processed wins — a known limitation of the single envContent field.
    const allSensitiveVars: Record<string, string> = {};

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

      // Split env vars into sensitive (routed to encrypted envContent) and
      // non-sensitive (inlined in the compose environment: block).
      const publicVars: Record<string, string> = {};
      const sensitiveVars: Record<string, string> = {};
      for (const [k, v] of Object.entries(envVars)) {
        if (isSensitiveEnvKey(k)) {
          sensitiveVars[k] = v;
        } else {
          publicVars[k] = v;
        }
      }
      // Accumulate sensitive vars for the shared envContent written after the loop.
      Object.assign(allSensitiveVars, sensitiveVars);

      // Strip the compose-project default network from networkMode so the
      // generated compose doesn't declare an external network that will be
      // orphaned after the original containers are removed. Docker Compose
      // creates a shared default network for all services in the same file,
      // so inter-service DNS resolution works without explicitly preserving
      // the old project's network.
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
        // hasEnvVars adds env_file: [".env"] to the service. Set it when this
        // service has sensitive vars that will be written to the encrypted env file.
        hasEnvVars: Object.keys(sensitiveVars).length > 0,
      });

      // Reconstruct depends_on from Docker Compose labels. The container label
      // com.docker.compose.depends_on encodes the original dependency graph
      // (e.g. "redis:service_started:false,postgres:service_healthy:false").
      // The object form preserves health-check conditions (service_healthy).
      const dependsOn = parseComposeDependsOn(detail.labels);
      if (Object.keys(dependsOn).length > 0) {
        singleFile.services[serviceName].depends_on = dependsOn;
      }

      // Inline non-sensitive env vars for this service directly in the compose.
      const composeSvc = singleFile.services[serviceName];
      if (composeSvc && Object.keys(publicVars).length > 0) {
        composeSvc.environment = publicVars;
      }

      // Inject Traefik labels for services that have a detectable domain but no
      // existing Traefik router labels. Services that already carry traefik.*
      // labels (preserved from the original container) keep their own config.
      const hasExistingTraefikRouter = Object.keys(detail.labels).some(
        (k) => /^traefik\.http\.routers\..+\.rule$/.test(k)
      );
      // Container port — resolved by detectContainerPort in getContainerDetail:
      // Traefik labels → ExposedPorts → PortBindings fallback chain.
      const containerPort = detail.containerPort;

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

      // Merge this service's compose file into the combined file.
      // Networks matching the compose project's default pattern are excluded —
      // they are ephemeral and will not exist after the original containers
      // are removed.
      mergeComposeFile(merged, singleFile, composeProject);

      // Accumulate mounts for volume DB records
      for (const mount of detail.mounts) {
        allMounts.push(mount);
      }
    }

    // Clean up empty network declarations
    if (merged.networks && Object.keys(merged.networks).length === 0) {
      delete merged.networks;
    }

    // Extract containerPort and backendProtocol from the primary service's
    // Traefik labels. The deploy engine strips and regenerates Traefik labels
    // from these app-record fields, so they must be set correctly for features
    // like serversTransport (HTTPS backends) to survive the round-trip.
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
    // Auto-detect from port if scheme label wasn't set
    if (!importedBackendProtocol && importedContainerPort && (importedContainerPort === 443 || importedContainerPort === 8443)) {
      importedBackendProtocol = "https";
    }

    const composeContent = composeToYaml(merged);

    // Encrypt sensitive vars collected across all services.
    let envContent: string | null = null;
    if (Object.keys(allSensitiveVars).length > 0) {
      const envLines = Object.entries(allSensitiveVars)
        .map(([k, v]) => `${k}=${v.replace(/\r?\n/g, "\\n")}`)
        .join("\n");
      envContent = encrypt(envLines, orgId);
    }

    // When gitUrl is provided (or auto-detected), use git source so Vardo
    // clones the repo and builds from docker-compose.yml with build: directives.
    // Otherwise fall back to direct source using the generated compose with image: refs.
    const useGitSource = !!effectiveGitUrl;

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
            source: useGitSource ? "git" : "direct",
            deployType: "compose",
            // When using git source, don't store composeContent — let deploy
            // read the compose file from the cloned repo instead.
            composeContent: useGitSource ? null : composeContent,
            gitUrl: effectiveGitUrl ?? null,
            gitBranch: effectiveGitBranch ?? null,
            // autoTraefikLabels is false — Traefik config is baked into the
            // compose content either from the original container labels or via
            // explicit injectTraefikLabels above. Regenerating at deploy time
            // would overwrite service-specific routing configs.
            autoTraefikLabels: false,
            containerPort: importedContainerPort,
            backendProtocol: importedBackendProtocol,
            projectId: resolvedProjectId,
            envContent,
            importedComposeProject: composeProject,
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

        // Create volume records for all mounts across all services.
        // Deduplicate by mountPath to avoid unique-constraint violations when
        // multiple services share the same host path.
        const seenMountPaths = new Set<string>();
        const volumeRows: (typeof volumes)["$inferInsert"][] = [];
        for (const mount of allMounts) {
          if (seenMountPaths.has(mount.destination)) continue;
          seenMountPaths.add(mount.destination);
          volumeRows.push({
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
        if (volumeRows.length > 0) {
          await tx.insert(volumes).values(volumeRows);
        }

        return { app };
      });
    } catch (txError) {
      if (txError instanceof Error && txError.message === "PROJECT_NOT_FOUND") {
        return NextResponse.json({ error: "Project not found" }, { status: 400 });
      }
      // Race condition: another request inserted between our pre-check and insert.
      // Do the same lookup as the pre-checks so the client can redirect to the
      // existing app. Try by slug first, then by compose project.
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
            error: "An app with this slug already exists in this organization",
            ...(existing ? { appId: existing.id } : {}),
          },
          { status: 409 }
        );
      }
      throw txError;
    }

    const { app } = result;
    const appId = app.id;

    // Warn about local images, host networking, and @file provider references
    for (const detail of validDetails) {
      const svcName =
        (detail.labels["com.docker.compose.service"] ?? slugify(detail.name)) || slugify(detail.name);
      // Only warn about local images if we're not using git source (which will build them)
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
        ...(autoDetectedGit && { gitAutoDetected: true, gitUrl: effectiveGitUrl }),
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

    return NextResponse.json({
      app,
      warnings,
      deploymentId,
      migrated: false,
      ...(autoDetectedGit && { gitAutoDetected: true, gitUrl: effectiveGitUrl }),
    }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error importing compose group");
  }
}

export const POST = withRateLimit(handler, { tier: "mutation", key: "discover-import" });
