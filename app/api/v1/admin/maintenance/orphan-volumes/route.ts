import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { deleteOrphanVolumes, findOrphanVolumes, measureOrphans, volumeSizes } from "@/lib/docker/orphan-volumes";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:orphan-volumes");

// GET /api/v1/admin/maintenance/orphan-volumes — volumes nothing mounts or claims. `?sizes=1` adds sizes; `measuring: true` means ask again.
async function handleGet(request: NextRequest) {
  try {
    await requireAppAdmin();
    const found = await findOrphanVolumes();
    if (request.nextUrl.searchParams.get("sizes") === "1") return NextResponse.json(await measureOrphans(found));
    // Starts df now so sizes are ready sooner.
    if (found.length > 0) void volumeSizes();
    return NextResponse.json({ volumes: found });
  } catch (error) {
    return handleRouteError(error, "Error listing unused volumes");
  }
}

const deleteSchema = z
  .object({
    names: z.array(z.string().min(1).max(255)).min(1).max(500),
    confirm: z.literal(true),
  })
  .strict();

// DELETE — removes the named volumes after rechecking each one. Body: { names, confirm: true }.
async function handleDelete(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = deleteSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });

    const results = await deleteOrphanVolumes([...new Set(parsed.data.names)]);
    const removed = results.filter((r) => r.ok).map((r) => r.name);
    if (removed.length > 0) log.info(`removed ${removed.length} unused volume(s): ${removed.join(", ")}`);
    return NextResponse.json({ results });
  } catch (error) {
    return handleRouteError(error, "Error removing unused volumes");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/maintenance/orphan-volumes" });
export const DELETE = withRateLimit(handleDelete, { tier: "critical", key: "maintenance:orphan-volumes" });
