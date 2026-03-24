import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { volumes } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { verifyAppAccess } from "@/lib/api/verify-access";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string }>;
};

const MIN_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_SIZE_BYTES = 100 * 1024 * 1024 * 1024; // 100 GB

const volumeLimitSchema = z.object({
  maxSizeBytes: z
    .number()
    .int()
    .min(MIN_SIZE_BYTES, `Minimum size is 10 MB`)
    .max(MAX_SIZE_BYTES, `Maximum size is 100 GB`),
  warnAtPercent: z.number().int().min(1).max(100).default(80),
});

// GET — return the aggregate volume limit for an app
// (reads maxSizeBytes/warnAtPercent from the first volume that has a limit set)
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    // Find any volume with a limit set
    const volWithLimit = await db.query.volumes.findFirst({
      where: eq(volumes.appId, appId),
      columns: { maxSizeBytes: true, warnAtPercent: true },
    });

    if (volWithLimit?.maxSizeBytes) {
      return NextResponse.json({
        limit: {
          maxSizeBytes: volWithLimit.maxSizeBytes,
          warnAtPercent: volWithLimit.warnAtPercent ?? 80,
        },
      });
    }

    return NextResponse.json({ limit: null });
  } catch (error) {
    return handleRouteError(error, "Error fetching volume limit");
  }
}

// PUT — set/update the volume limit on all volumes for this app
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

    // Apply limit to all volumes for this app
    await db
      .update(volumes)
      .set({
        maxSizeBytes: parsed.data.maxSizeBytes,
        warnAtPercent: parsed.data.warnAtPercent,
        updatedAt: new Date(),
      })
      .where(eq(volumes.appId, appId));

    return NextResponse.json({
      limit: {
        maxSizeBytes: parsed.data.maxSizeBytes,
        warnAtPercent: parsed.data.warnAtPercent,
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error setting volume limit");
  }
}

// DELETE — remove the volume limit from all volumes for this app
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId } = await params;
    const app = await verifyAppAccess(orgId, appId);

    if (!app) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await db
      .update(volumes)
      .set({
        maxSizeBytes: null,
        warnAtPercent: 80,
        updatedAt: new Date(),
      })
      .where(eq(volumes.appId, appId));

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleRouteError(error, "Error deleting volume limit");
  }
}
