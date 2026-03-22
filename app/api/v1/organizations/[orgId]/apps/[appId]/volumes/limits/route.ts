import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { volumeLimits } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const volumeLimitSchema = z.object({
  maxSizeBytes: z.number().int().positive("Max size must be a positive number"),
  warnAtPercent: z.number().int().min(1).max(100).default(80),
});

// GET — return the volume limit for an app (or null if not set)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const limit = await db.query.volumeLimits.findFirst({
      where: eq(volumeLimits.appId, appId),
    });

    return NextResponse.json({ limit: limit ?? null });
  } catch (error) {
    return handleRouteError(error, "Error fetching volume limit");
  }
}

// PUT — set/update the volume limit
export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = volumeLimitSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    // Upsert: try to update first, insert if not exists
    const existing = await db.query.volumeLimits.findFirst({
      where: eq(volumeLimits.appId, appId),
    });

    let limit;
    if (existing) {
      [limit] = await db
        .update(volumeLimits)
        .set({
          maxSizeBytes: parsed.data.maxSizeBytes,
          warnAtPercent: parsed.data.warnAtPercent,
          updatedAt: new Date(),
        })
        .where(eq(volumeLimits.id, existing.id))
        .returning();
    } else {
      [limit] = await db
        .insert(volumeLimits)
        .values({
          id: nanoid(),
          appId,
          maxSizeBytes: parsed.data.maxSizeBytes,
          warnAtPercent: parsed.data.warnAtPercent,
        })
        .returning();
    }

    return NextResponse.json({ limit });
  } catch (error) {
    return handleRouteError(error, "Error setting volume limit");
  }
}

// DELETE — remove the volume limit
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const [deleted] = await db
      .delete(volumeLimits)
      .where(eq(volumeLimits.appId, appId))
      .returning({ id: volumeLimits.id });

    if (!deleted) {
      return NextResponse.json({ error: "No limit set" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting volume limit");
  }
}
