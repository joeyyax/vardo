import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const createTargetSchema = z.object({
  name: z.string().min(1, "Name is required"),
  type: z.enum(["local", "s3", "r2", "tailscale"]),
  config: z.union([
    z.object({
      path: z.string().min(1, "Path is required"),
    }),
    z.object({
      bucket: z.string().min(1),
      region: z.string().min(1),
      endpoint: z.string().optional(),
      accessKeyId: z.string().min(1),
      secretAccessKey: z.string().min(1),
    }),
    z.object({
      tailnet: z.string().min(1),
      node: z.string().min(1),
      path: z.string().min(1),
    }),
  ]),
  isDefault: z.boolean().default(false),
});

// GET /api/v1/organizations/[orgId]/backups/targets
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const targets = await db.query.backupTargets.findMany({
      where: eq(backupTargets.organizationId, orgId),
    });

    return NextResponse.json({ targets });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error fetching backup targets:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// POST /api/v1/organizations/[orgId]/backups/targets
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createTargetSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const data = parsed.data;

    const [target] = await db
      .insert(backupTargets)
      .values({
        id: nanoid(),
        organizationId: orgId,
        name: data.name,
        type: data.type,
        config: data.config,
        isDefault: data.isDefault,
      })
      .returning();

    return NextResponse.json({ target }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    console.error("Error creating backup target:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
