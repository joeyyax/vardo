import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { projects, domains, organizations } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { generateSubdomain } from "@/lib/domains/auto-domain";

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
    deployType: z.enum(["compose", "dockerfile", "image", "static"]),
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
    const { organization } = await requireOrg();

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
