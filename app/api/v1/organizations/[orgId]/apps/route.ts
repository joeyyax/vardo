import { NextRequest, NextResponse } from "next/server";
import { apiError, handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
import {
  APP_NAME_TAKEN_ERROR,
  isAppNameViolation,
  isTopLevelAppNameTaken,
} from "@/lib/db/app-name";
import { db } from "@/lib/db";
import { apps, projects, domains, organizations, environments, volumes } from "@/lib/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createAppSchema } from "@/lib/api/create-app-schema";
import { getBaseDomain } from "@/lib/domain-monitoring/base-domain";
import { allocatePorts } from "@/lib/docker/ports";
import { sharedMarkerTypeErrors } from "@/lib/docker/compose";
import { recordActivity } from "@/lib/activity";
import { isReservedSlug } from "@/lib/domain-monitoring/reserved";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { readableApp } from "@/lib/api/readable-app";
import { gitUrlColumns } from "@/lib/api/git-credentials";
import { can } from "@/lib/auth/permissions";
import { getSslConfig, getDefaultCertResolver } from "@/lib/system-settings";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { enrollQuietly } from "@/lib/backups/enroll";
import { findPrefixOwner, prefixCollisionMessage } from "@/lib/docker/volume-prefix";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps?limit=50&offset=0
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return apiError.forbidden();

    const searchParams = request.nextUrl.searchParams;
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 100);
    const offset = Math.max(parseInt(searchParams.get("offset") || "0", 10), 0);

    const [appList, totalResult] = await Promise.all([
      db.query.apps.findMany({
        where: eq(apps.organizationId, orgId),
        with: {
          deployments: {
            columns: { id: true, status: true, startedAt: true },
            orderBy: (d, { desc }) => [desc(d.startedAt)],
            limit: 1,
          },
          appTags: {
            with: { tag: true },
          },
          project: true,
        },
        orderBy: [desc(apps.createdAt)],
        limit,
        offset,
      }),
      db.select({ count: sql`count(*)::int` })
        .from(apps)
        .where(eq(apps.organizationId, orgId)),
    ]);

    const reveal = can(org.membership, "env.reveal");
    return NextResponse.json({
      apps: appList.map((app) => readableApp(app, reveal)),
      total: totalResult[0]?.count ?? 0,
      limit,
      offset,
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching apps");
  }
}

// POST /api/v1/organizations/[orgId]/apps
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "app.create");
    if (!org) return apiError.forbidden();

    const body = await request.json();
    const parsed = createAppSchema.safeParse(body);

    if (!parsed.success) {
      return apiError.validation(parsed.error);
    }

    const data = parsed.data;

    // The parser drops a quoted x-vardo-shared, so check the raw YAML before storing.
    const markerErrors = sharedMarkerTypeErrors(data.composeContent ?? "");
    if (markerErrors.length > 0) {
      return NextResponse.json(
        { error: markerErrors.join("\n"), errors: markerErrors },
        { status: 400 }
      );
    }

    // Reserved slugs apply only to subdomains on the base domain.
    if (data.generateDomain && isReservedSlug(data.name)) {
      // Admins bypass.
      const { isAppAdmin } = await import("@/lib/auth/admin");
      if (!(await isAppAdmin())) {
        return NextResponse.json(
          { error: `"${data.name}" is a reserved name. Choose a different slug.` },
          { status: 400 }
        );
      }
    }

    if (await isTopLevelAppNameTaken(data.name)) {
      return NextResponse.json({ error: APP_NAME_TAKEN_ERROR }, { status: 409 });
    }

    const orgRecord = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { slug: true, baseDomain: true },
    });

    // The slug is the subdomain.
    const autoDomain = data.generateDomain
      ? `${data.name}.${await getBaseDomain(orgRecord?.baseDomain)}`
      : null;

    if (autoDomain) {
      const domainTaken = await db.query.domains.findFirst({
        where: eq(domains.domain, autoDomain),
        columns: { id: true },
      });
      if (domainTaken) {
        return NextResponse.json(
          { error: `${autoDomain} is already in use. Choose a different slug.` },
          { status: 409 }
        );
      }
    }

    const appId = nanoid();

    // projectId must exist in this org.
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, data.projectId), eq(projects.organizationId, orgId)),
      columns: { id: true },
    });
    if (!project) {
      return NextResponse.json(
        { error: "Project not found in this organization" },
        { status: 400 }
      );
    }

    {
      const owner = await findPrefixOwner(data.name, "production");
      if (owner) return NextResponse.json({ error: prefixCollisionMessage(owner) }, { status: 409 });
    }

    const [app] = await db
      .insert(apps)
      .values({
        id: appId,
        organizationId: orgId,
        name: data.name,
        displayName: data.displayName,
        description: data.description,
        source: data.source,
        deployType: data.deployType,
        ...gitUrlColumns(data.gitUrl, orgId),
        gitBranch: data.gitBranch || "main",
        imageName: data.imageName,
        composeContent: data.composeContent,
        composeFilePath: data.composeFilePath || "docker-compose.yml",
        dockerfilePath: data.dockerfilePath || "Dockerfile",
        rootDirectory: data.rootDirectory,
        templateName: data.templateName,
        containerPort: data.containerPort,
        autoTraefikLabels: data.autoTraefikLabels,
        autoDeploy: data.autoDeploy,
        projectId: data.projectId,
        persistentVolumes: data.persistentVolumes,
        exposedPorts: data.exposedPorts ? await (async () => {
          // Auto-allocate external ports for any that don't have one
          const needAllocation = data.exposedPorts!.filter((p) => !p.external);
          if (needAllocation.length > 0) {
            const allocated = await allocatePorts(needAllocation.length);
            let i = 0;
            return data.exposedPorts!.map((p) =>
              p.external ? p : { ...p, external: allocated[i++] }
            );
          }
          return data.exposedPorts;
        })() : undefined,
        connectionInfo: data.connectionInfo,
        cpuLimit: data.cpuLimit ?? null,
        memoryLimit: data.memoryLimit ?? null,
        diskWriteAlertThreshold: data.diskWriteAlertThreshold ?? null,
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

    // Create volume records from persistentVolumes input
    if (data.persistentVolumes?.length) {
      for (const vol of data.persistentVolumes) {
        await db.insert(volumes).values({
          id: nanoid(),
          appId,
          organizationId: orgId,
          name: vol.name,
          mountPath: vol.mountPath,
          persistent: true,
        });
      }
      await enrollQuietly({ appId, appName: data.name, organizationId: orgId });
    }

    // Auto-create domain if requested
    if (autoDomain) {
      const sslConfig = await getSslConfig();
      await db.insert(domains).values({
        id: nanoid(),
        appId,
        domain: autoDomain,
        port: data.containerPort ?? null,
        certResolver: getDefaultCertResolver(sslConfig),
      });
    }

    recordActivity({
      organizationId: orgId,
      action: "app.created",
      appId,
      userId: org.session.user.id,
      metadata: { name: data.name, displayName: data.displayName },
    });

    return NextResponse.json({ app: readableApp(app, true) }, { status: 201 });
  } catch (error) {
    // Unique constraint violation (Postgres error code 23505)
    if (isAppNameViolation(error)) {
      return NextResponse.json({ error: APP_NAME_TAKEN_ERROR }, { status: 409 });
    }
    if (isUniqueViolation(error)) {
      return NextResponse.json(
        { error: "An app with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating app");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-apps" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/organizations/*/apps" });
