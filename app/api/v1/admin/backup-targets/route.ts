import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { backupTargets } from "@/lib/db/schema";
import { isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { requireAppAdmin } from "@/lib/auth/admin";
import { isLocalBackupsAllowed } from "@/lib/config/provider-restrictions";

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

// GET /api/v1/admin/backup-targets — list app-level targets
export async function GET() {
  try {
    await requireAppAdmin();

    const targets = await db.query.backupTargets.findMany({
      where: isNull(backupTargets.organizationId),
    });

    return NextResponse.json({ targets, allowLocalBackups: isLocalBackupsAllowed() });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error fetching admin backup targets");
  }
}

// POST /api/v1/admin/backup-targets — create app-level target
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = createTargetSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const data = parsed.data;

    // Reject SSH/local targets if restricted by deployment config
    if (data.type === "ssh" && !isLocalBackupsAllowed()) {
      return NextResponse.json(
        { error: "SSH/local backup targets are not available on this instance" },
        { status: 403 },
      );
    }

    const [target] = await db
      .insert(backupTargets)
      .values({
        id: nanoid(),
        organizationId: null, // app-level
        name: data.name,
        type: data.type,
        config: data.config,
        isDefault: data.isDefault,
      })
      .returning();

    return NextResponse.json({ target }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error creating admin backup target");
  }
}
