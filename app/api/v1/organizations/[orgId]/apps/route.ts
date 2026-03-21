import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { apps, projects, domains, organizations, environments } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { generateSubdomain } from "@/lib/domains/auto-domain";
import { allocatePorts } from "@/lib/docker/ports";
import { recordActivity } from "@/lib/activity";
import { isReservedSlug } from "@/lib/domains/reserved";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createAppSchema = z
  .object({
    displayName: z.string().min(1, "Display name is required"),
    name: z
      .string()
      .min(1, "Name is required")
      .regex(/^[a-z0-9-]+$/, "Name must be lowercase alphanumeric with hyphens"),
    description: z.string().optional(),
    source: z.enum(["git", "direct"]),
    deployType: z.enum(["compose", "dockerfile", "image", "static", "nixpacks"]),
    gitUrl: z.string().optional(),
    gitBranch: z.string().optional(),
    imageName: z.string().optional(),
    composeContent: z.string().optional(),
    composeFilePath: z.string().optional(),
    rootDirectory: z.string().optional(),
    containerPort: z.number().int().positive().optional(),
    autoTraefikLabels: z.boolean().default(false),
    autoDeploy: z.boolean().default(false),
    generateDomain: z.boolean().default(true),
    persistentVolumes: z.array(z.object({
      name: z.string(),
      mountPath: z.string(),
    })).optional(),
    exposedPorts: z.array(z.object({
      internal: z.number(),
      external: z.number().optional(),
      protocol: z.string().optional(),
      description: z.string().optional(),
    })).optional(),
    connectionInfo: z.array(z.object({
      label: z.string(),
      value: z.string(),
      copyRef: z.string().optional(),
    })).optional(),
    projectId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (data.source === "git") return !!data.gitUrl;
      if (data.deployType === "image") return !!data.imageName;
      return true;
    },
    {
      message: "Required fields missing for the selected configuration",
    }
  );

// GET /api/v1/organizations/[orgId]/apps
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const appList = await db.query.apps.findMany({
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
    });

    return NextResponse.json({ apps: appList });
  } catch (error) {
    return handleRouteError(error, "Error fetching apps");
  }
}

// POST /api/v1/organizations/[orgId]/apps
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createAppSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Check reserved slugs — only when generating a subdomain on our base domain
    if (data.generateDomain && isReservedSlug(data.name)) {
      // Allow admins to bypass
      const { user: userTable } = await import("@/lib/db/schema");
      const dbUser = await db.query.user.findFirst({
        where: eq(userTable.id, session.user.id),
        columns: { isAppAdmin: true },
      });
      if (!dbUser?.isAppAdmin) {
        return NextResponse.json(
          { error: `"${data.name}" is a reserved name. Choose a different slug.` },
          { status: 400 }
        );
      }
    }

    // Fetch org for baseDomain
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { slug: true, baseDomain: true },
    });

    const appId = nanoid();

    // Validate projectId — must exist in same org
    if (data.projectId) {
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
        gitUrl: data.gitUrl,
        gitBranch: data.gitBranch || "main",
        imageName: data.imageName,
        composeContent: data.composeContent,
        composeFilePath: data.composeFilePath || "docker-compose.yml",
        rootDirectory: data.rootDirectory,
        containerPort: data.containerPort,
        autoTraefikLabels: data.autoTraefikLabels,
        autoDeploy: data.autoDeploy,
        projectId: data.projectId || null,
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

    // Auto-create domain if requested
    if (data.generateDomain) {
      const autoDomain = generateSubdomain(data.name, org?.baseDomain);
      await db.insert(domains).values({
        id: nanoid(),
        appId,
        domain: autoDomain,
        port: data.containerPort ?? null,
        certResolver: "le",
      });
    }

    recordActivity({
      organizationId: orgId,
      action: "app.created",
      appId,
      userId: session.user.id,
      metadata: { name: data.name, displayName: data.displayName },
    });

    return NextResponse.json({ app }, { status: 201 });
  } catch (error) {
    // Unique constraint violation (Postgres error code 23505)
    const pgCode = error instanceof Error
      ? ("code" in error ? (error as { code: string }).code : null) ??
        (error.cause && typeof error.cause === "object" && "code" in error.cause ? (error.cause as { code: string }).code : null)
      : null;
    if (pgCode === "23505") {
      return NextResponse.json(
        { error: "An app with this name already exists" },
        { status: 409 }
      );
    }
    return handleRouteError(error, "Error creating app");
  }
}
