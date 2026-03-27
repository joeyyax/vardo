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

    // Generate compose file
    const namedVolumes = data.importVolumes
      ? detail.mounts
          .filter((m) => m.type === "volume")
          .map((m) => ({ name: m.source, mountPath: m.destination }))
      : [];

    let compose = generateComposeForImage({
      projectName: data.name,
      imageName: detail.image,
      containerPort: containerPort ?? undefined,
      volumes: namedVolumes,
      exposedPorts: detail.ports.filter((p) => p.external),
    });

    // Inject Traefik labels if a domain was found
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

        // Create volume records
        if (data.importVolumes && detail.mounts.length > 0) {
          for (const mount of detail.mounts) {
            await tx.insert(volumes).values({
              id: nanoid(),
              appId,
              organizationId: orgId,
              name: mount.source || mount.destination.replace(/\//g, "-").replace(/^-/, ""),
              mountPath: mount.destination,
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

    const bindMounts = detail.mounts.filter((m) => m.type === "bind");
    if (data.importVolumes && bindMounts.length > 0) {
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
    // Stop the original container, deploy through the Vardo engine so the
    // app shows up as managed on the dashboard, then remove the old container.
    // On any deploy failure the original container is restarted so nothing
    // is lost and the operator can retry with a manual deploy.

    let containerStopped = false;

    try {
      await stopContainer(containerId);
      containerStopped = true;
    } catch (stopError) {
      warnings.push(
        "Could not stop the original container automatically — the app record has been created but the migration was not completed. Trigger a manual deploy to finish."
      );
      return NextResponse.json({ app, warnings, migrated: false }, { status: 201 });
    }

    let migrated = false;

    try {
      const deployResult = await requestDeploy({
        appId,
        organizationId: orgId,
        trigger: "api",
        triggeredBy: org.session.user.id,
      });

      if (!deployResult.success) {
        throw new Error(deployResult.log || "Deployment did not succeed");
      }

      migrated = true;
    } catch {
      // Restart the original container so the service keeps running while the
      // operator figures out what went wrong.
      if (containerStopped) {
        try {
          await startContainer(containerId);
        } catch {
          // Best effort — log and move on.
        }
      }

      warnings.push(
        "Container import recorded but the Vardo deployment failed. The original container has been restarted. Trigger a manual deploy to retry the migration."
      );

      return NextResponse.json({ app, warnings, migrated: false }, { status: 201 });
    }

    // Deployment succeeded — remove the old container.
    try {
      await removeContainer(containerId);
    } catch {
      warnings.push(
        `Original container could not be removed automatically. Remove it manually: docker rm ${containerId}`
      );
    }

    return NextResponse.json({ app, warnings, migrated }, { status: 201 });
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
