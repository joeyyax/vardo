import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { volumes } from "@/lib/db/schema";
import { verifyAppAccess } from "@/lib/api/verify-access";
import { eq, and } from "drizzle-orm";
import { z } from "zod";

type RouteParams = {
  params: Promise<{ orgId: string; appId: string; volumeName: string }>;
};

const patchSchema = z.object({
  ignorePatterns: z.array(z.string().min(1).max(200)).max(100).optional(),
  description: z.string().max(500).optional(),
}).strict();

/**
 * PATCH — Update volume metadata (ignore patterns, description).
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, appId, volumeName } = await params;
    const appRecord = await verifyAppAccess(orgId, appId);
    if (!appRecord) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 },
      );
    }

    const volume = await db.query.volumes.findFirst({
      where: and(eq(volumes.appId, appId), eq(volumes.name, volumeName)),
    });
    if (!volume) {
      return NextResponse.json({ error: "Volume not found" }, { status: 404 });
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (parsed.data.ignorePatterns !== undefined) {
      updates.ignorePatterns = parsed.data.ignorePatterns;
    }
    if (parsed.data.description !== undefined) {
      updates.description = parsed.data.description;
    }

    await db.update(volumes).set(updates).where(eq(volumes.id, volume.id));

    const updated = await db.query.volumes.findFirst({
      where: eq(volumes.id, volume.id),
    });

    return NextResponse.json({ volume: updated });
  } catch (error) {
    return handleRouteError(error, "Error updating volume");
  }
}
