import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { db } from "@/lib/db";
import { apps, environments, domains, volumes, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getContainerDetail, isLocalImage } from "@/lib/docker/discover";
import { slugify } from "@/lib/ui/slugify";
import { generateComposeForImage, injectTraefikLabels, composeToYaml } from "@/lib/docker/compose";
import { encrypt } from "@/lib/crypto/encrypt";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";
import { stopContainer, startContainer, removeContainer } from "@/lib/docker/client";
import { createDeployment } from "@/lib/docker/deploy";
import { requestDeploy } from "@/lib/docker/deploy-cancel";

type RouteParams = {
  params: Promise<{ orgId: string; containerId: string }>;
};

const importSchema = z.object({
  projectId: z.string().nullable().optional(),
  newProjectName: z.string().min(1).optional(),
  displayName: z.string().min(1, "Display name is required"),
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
          .refine((v) => !/[\x00-\x1f\x7f]/.test(v), "Value cannot contain control characters"),
      })
    )
    .max(500, "Too many environment variables")
    .default([]),
  // Array of container-side destination paths to import; empty array = no mounts.
  // If omitted, falls back to importVolumes for backward compatibility.
  selectedMountDestinations: z.array(z.string().max(4096, "Mount destination too long")).max(100, "Too many mount destinations").optional(),
  // Deprecated: use selectedMountDestinations. Kept for backward compatibility.
  importVolumes: z.boolean().default(true),
});

// POST /api/v1/organizations/[orgId]/discover/containers/[containerId]/import
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, containerId } = await params;

    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
      return NextResponse.json({ error: "Invalid container ID" }, { status: 400 });
    }

    const body = await request.json();
    const parsed = importSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    }

    const data = parsed.data;

    // Check for duplicate import
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

    // Inspect container server-side
    const detail = await getContainerDetail(containerId);
    if (!detail) {
      return NextResponse.json(
        { error: "Container not found or is Vardo-managed" },
        { status: 404 }
      );
    }

    // Determine container port — prefer Traefik-detected, then first exposed port
    const containerPort =
      detail.containerPort ??
      detail.ports.find((p) => p.internal)?.internal ??
      null;

    // Resolve which mounts to import
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

    // Generate compose file
    const namedVolumes = mountsToImport
      .filter((m) => m.type === "volume")
      .map((m) => ({ name: m.source, mountPath: m.destination }));

    let compose = generateComposeForImage({
      projectName: data.name,
      imageName: detail.image,
      containerPort: containerPort ?? undefined,
      volumes: namedVolumes,
      exposedPorts: detail.ports.filter((p) => p.external),
    });

    // Inject Traefik labels if a domain was found.
    // TODO: if container import ever produces multi-service or host-network compose files,
    // pass serviceName here (the first bridge-network service) as deploy.ts does.
    const sslConfig = await getSslConfig();
    if (detail.domain && containerPort) {
      compose = injectTraefikLabels(compose, {
        projectName: data.name,
        domain: detail.domain,
        containerPort,
        certResolver: getPrimaryIssuer(sslConfig),
      });
    }

    const composeContent = composeToYaml(compose);

    // Build env content string from user-reviewed vars
    let envContent: string | null = null;
    if (data.envVars.length > 0) {
      const envLines = data.envVars.map(({ key, value }) => `${key}=${value}`).join("\n");
      envContent = encrypt(envLines, orgId);
    }

    let result: { app: (typeof apps)["$inferSelect"] };
    try {
      result = await db.transaction(async (tx) => {
        // Resolve projectId — create new project if requested
        let resolvedProjectId: string | null = data.projectId ?? null;

        if (data.newProjectName) {
          const newProjectId = nanoid();
          const newProjectSlug = slugify(data.newProjectName);
          await tx.insert(projects).values({
            id: newProjectId,
            organizationId: orgId,
            name: newProjectSlug,
            displayName: data.newProjectName,
          });
          resolvedProjectId = newProjectId;
        } else if (resolvedProjectId) {
          // Verify the project belongs to this org
          const project = await tx.query.projects.findFirst({
            where: and(eq(projects.id, resolvedProjectId), eq(projects.organizationId, orgId)),
            columns: { id: true },
          });
          if (!project) {
            throw new Error("PROJECT_NOT_FOUND");
          }
        }

        // Insert app record
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
            autoTraefikLabels: false,
            projectId: resolvedProjectId,
            envContent,
            importedContainerId: containerId,
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

        // Create domain record if Traefik domain was found
        if (detail.domain && containerPort) {
          await tx.insert(domains).values({
            id: nanoid(),
            appId,
            domain: detail.domain,
            port: containerPort,
            certResolver: getPrimaryIssuer(sslConfig),
            isPrimary: true,
          });
        }

        // Create volume records for selected mounts
        if (mountsToImport.length > 0) {
          for (const mount of mountsToImport) {
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

    // --- Migrate the container into Vardo management ---
    //
    // Pre-create the deployment record so the client has an ID to poll.
    // Then fire the migration (stop → deploy → remove) async so the HTTP
    // response is not held open while waiting for a lock or running the
    // build. On any deploy failure the original container is restarted.

    const deploymentId = await createDeployment({
      appId,
      organizationId: orgId,
      trigger: "api",
      triggeredBy: org.session.user.id,
    });

    void (async () => {
      let containerStopped = false;

      try {
        await stopContainer(containerId);
        containerStopped = true;
      } catch {
        // Can't stop the container — leave it running; the operator can
        // trigger a manual deploy once they've resolved the issue.
        return;
      }

      try {
        const deployResult = await requestDeploy({
          appId,
          organizationId: orgId,
          trigger: "api",
          triggeredBy: org.session.user.id,
          deploymentId,
        });

        if (!deployResult.success) {
          throw new Error(deployResult.log || "Deployment did not succeed");
        }
      } catch {
        // Restart the original container so the service keeps running while
        // the operator figures out what went wrong.
        if (containerStopped) {
          try {
            await startContainer(containerId);
          } catch {
            // Best effort — move on.
          }
        }
        return;
      }

      // Deployment succeeded — remove the old container.
      // Pass force=true so a still-running container (e.g. stop was swallowed)
      // doesn't leave a 409 error.
      try {
        await removeContainer(containerId, { force: true });
      } catch {
        // Non-fatal — operator can remove manually.
      }
    })();

    return NextResponse.json({ app, warnings, deploymentId, migrated: false }, { status: 201 });
  } catch (error) {
    const pgCode =
      error instanceof Error
        ? ("code" in error ? (error as { code: string }).code : null) ??
          (error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause
            ? (error.cause as { code: string }).code
            : null)
        : null;
    if (pgCode === "23505") {
      const rawConstraint =
        error instanceof Error && "constraint" in error
          ? (error as { constraint: unknown }).constraint
          : error instanceof Error &&
              error.cause &&
              typeof error.cause === "object" &&
              "constraint" in error.cause
            ? (error.cause as { constraint: unknown }).constraint
            : null;
      const constraintName = typeof rawConstraint === "string" ? rawConstraint : null;
      if (constraintName === "app_imported_container_uniq") {
        return NextResponse.json(
          { error: "This container has already been imported" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: "An app with this slug already exists in this organization" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error importing container");
  }
}
