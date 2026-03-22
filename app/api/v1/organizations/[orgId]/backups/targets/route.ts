import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, or, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

const s3ConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1),
  endpoint: z.string().optional(),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  prefix: z.string().optional(),
});

const sshConfigSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  username: z.string().min(1),
  privateKey: z.string().optional(),
  path: z.string().min(1),
});

const createTargetSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string().min(1, "Name is required"),
    type: z.literal("s3"),
    config: s3ConfigSchema,
    isDefault: z.boolean().default(false),
  }),
  z.object({
    name: z.string().min(1, "Name is required"),
    type: z.literal("r2"),
    config: s3ConfigSchema,
    isDefault: z.boolean().default(false),
  }),
  z.object({
    name: z.string().min(1, "Name is required"),
    type: z.literal("b2"),
    config: s3ConfigSchema,
    isDefault: z.boolean().default(false),
  }),
  z.object({
    name: z.string().min(1, "Name is required"),
    type: z.literal("ssh"),
    config: sshConfigSchema,
    isDefault: z.boolean().default(false),
  }),
]);

// GET /api/v1/organizations/[orgId]/backups/targets
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Return both org-level targets and app-level targets (organizationId IS NULL)
    const targets = await db.query.backupTargets.findMany({
      where: or(
        eq(backupTargets.organizationId, orgId),
        isNull(backupTargets.organizationId),
      ),
    });

    // Mark app-level targets as read-only for the org
    const enriched = targets.map((t) => ({
      ...t,
      isAppLevel: t.organizationId === null,
    }));

    return NextResponse.json({ targets: enriched });
  } catch (error) {
    return handleRouteError(error, "Error fetching backup targets");
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
    return handleRouteError(error, "Error creating backup target");
  }
}
