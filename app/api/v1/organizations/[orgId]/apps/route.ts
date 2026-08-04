import { NextRequest, NextResponse } from "next/server";
import { handleRouteError, isUniqueViolation } from "@/lib/api/error-response";
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
import { getBaseDomain } from "@/lib/domain-monitoring/auto-domain";
import { allocatePorts } from "@/lib/docker/ports";
import { sharedMarkerTypeErrors } from "@/lib/docker/compose";
import { recordActivity } from "@/lib/activity";
import { isReservedSlug } from "@/lib/domain-monitoring/reserved";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { getSslConfig, getPrimaryIssuer } from "@/lib/system-settings";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { generateNamespace } from "@/lib/infra/app-namespace";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/apps?limit=50&offset=0
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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

    return NextResponse.json({
      apps: appList,
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
    const org = await verifyOrgAccess(orgId);
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = await request.json();
    const parsed = createAppSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // A quoted x-vardo-shared is dropped by the parser, so it has to be caught
    // against the raw YAML — before the compose is stored.
    const markerErrors = sharedMarkerTypeErrors(data.composeContent ?? "");
    if (markerErrors.length > 0) {
      return NextResponse.json(
        { error: markerErrors.join("\n"), errors: markerErrors },
        { status: 400 }
      );
    }

    // Check reserved slugs — only when generating a subdomain on our base domain
    if (data.generateDomain && isReservedSlug(data.name)) {
      // Allow admins to bypass
      const { user: userTable } = await import("@/lib/db/schema");
      const dbUser = await db.query.user.findFirst({
        where: eq(userTable.id, org.session.user.id),
        columns: { isAppAdmin: true },
      });
      if (!dbUser?.isAppAdmin) {
        return NextResponse.json(
          { error: `"${data.name}" is a reserved name. Choose a different slug.` },
          { status: 400 }
        );
      }
    }

    if (await isTopLevelAppNameTaken(data.name)) {
      return NextResponse.json({ error: APP_NAME_TAKEN_ERROR }, { status: 409 });
    }

    // Fetch org for baseDomain
    const orgRecord = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { slug: true, baseDomain: true },
    });

    // The slug is the subdomain, so what the form previewed is what gets created.
    const autoDomain = data.generateDomain
      ? `${data.name}.${getBaseDomain(orgRecord?.baseDomain)}`
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

    // Validate projectId — must exist in same org
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

    const [app] = await db
      .insert(apps)
      .values({
        id: appId,
        organizationId: orgId,
        name: data.name,
        namespace: generateNamespace(data.name),
        displayName: data.displayName,
        description: data.description,
        source: data.source,
        deployType: data.deployType,
        gitUrl: data.gitUrl,
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
    }

    // Auto-create domain if requested
    if (autoDomain) {
      const sslConfig = await getSslConfig();
      await db.insert(domains).values({
        id: nanoid(),
        appId,
        domain: autoDomain,
        port: data.containerPort ?? null,
        certResolver: getPrimaryIssuer(sslConfig),
      });
    }

    recordActivity({
      organizationId: orgId,
      action: "app.created",
      appId,
      userId: org.session.user.id,
      metadata: { name: data.name, displayName: data.displayName },
    });

    return NextResponse.json({ app }, { status: 201 });
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
