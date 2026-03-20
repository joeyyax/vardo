import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, domains, organizations } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { generateSubdomain } from "@/lib/domains/auto-domain";
import { allocatePorts } from "@/lib/docker/ports";
import { deployProject } from "@/lib/docker/deploy";
import { recordActivity } from "@/lib/activity";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createProjectSchema = z
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
    groupId: z.string().optional(),
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

// GET /api/v1/organizations/[orgId]/projects
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const projectList = await db.query.projects.findMany({
      where: eq(projects.organizationId, orgId),
      with: {
        deployments: {
          columns: { id: true, status: true, startedAt: true },
          orderBy: (d, { desc }) => [desc(d.startedAt)],
          limit: 1,
        },
        projectTags: {
          with: { tag: true },
        },
        projectGroups: {
          with: { group: true },
        },
      },
      orderBy: [desc(projects.createdAt)],
    });

    return NextResponse.json({ projects: projectList });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching projects:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/projects
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createProjectSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Fetch org for baseDomain
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { slug: true, baseDomain: true },
    });

    const projectId = nanoid();

    const [project] = await db
      .insert(projects)
      .values({
        id: projectId,
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
        groupId: data.groupId || null,
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

    // Auto-create domain if requested
    if (data.generateDomain) {
      const autoDomain = generateSubdomain(data.name, org?.baseDomain);
      await db.insert(domains).values({
        id: nanoid(),
        projectId,
        domain: autoDomain,
        port: data.containerPort ?? null,
        certResolver: "le",
      });
    }

    recordActivity({
      organizationId: orgId,
      action: "project.created",
      projectId,
      userId: session.user.id,
      metadata: { name: data.name, displayName: data.displayName },
    });

    // Auto-deploy if enabled — fire and forget, don't block the response
    if (data.autoDeploy) {
      deployProject({
        projectId,
        organizationId: orgId,
        trigger: "manual",
        triggeredBy: session.user.id,
      }).catch((err) => {
        console.error(`[auto-deploy] Failed for ${data.name}:`, err);
      });
    }

    return NextResponse.json({ project }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    // Unique constraint violation (Postgres error code 23505)
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505"
    ) {
      return NextResponse.json(
        { error: "A project with this name already exists" },
        { status: 409 }
      );
    }
    console.error("Error creating project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
