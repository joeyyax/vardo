import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { db } from "@/lib/db";
import { apps, environments, domains, volumes, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { getContainerDetail, isLocalImage } from "@/lib/docker/discover";
import { generateComposeForImage, injectTraefikLabels, composeToYaml } from "@/lib/docker/compose";
import { encrypt } from "@/lib/crypto/encrypt";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";
import { recordActivity } from "@/lib/activity";

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
  envVars: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
  importVolumes: z.boolean().default(true),
});

// POST /api/v1/organizations/[orgId]/discover/containers/[containerId]/import
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, containerId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

    // Resolve projectId — create new project if requested
    let resolvedProjectId: string | null = data.projectId ?? null;

    if (data.newProjectName) {
      const newProjectId = nanoid();
      await db.insert(projects).values({
        id: newProjectId,
        organizationId: orgId,
        name: data.newProjectName,
        displayName: data.newProjectName,
      });
      resolvedProjectId = newProjectId;
    } else if (resolvedProjectId) {
      // Verify the project belongs to this org
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, resolvedProjectId), eq(projects.organizationId, orgId)),
        columns: { id: true },
      });
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 400 });
      }
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

    // Insert app record
    const appId = nanoid();
    const [app] = await db
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
    await db.insert(environments).values({
      id: nanoid(),
      appId,
      name: "production",
      type: "production",
      isDefault: true,
    });

    // Create domain record if Traefik domain was found
    if (detail.domain && containerPort) {
      await db.insert(domains).values({
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
        await db.insert(volumes).values({
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

    return NextResponse.json({ app, warnings }, { status: 201 });
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
      return NextResponse.json(
        { error: "An app with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error importing container");
  }
}
