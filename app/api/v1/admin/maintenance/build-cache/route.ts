import { NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getSystemDiskUsage, pruneBuildCache } from "@/lib/docker/client";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:build-cache");

// GET /api/v1/admin/maintenance/build-cache — build cache size and reclaimable space.
// Both are null (unknown) on failure, never 0.
export async function GET() {
  try {
    await requireAppAdmin();

    try {
      const usage = await getSystemDiskUsage();
      return NextResponse.json({
        size: usage.buildCache.totalSize,
        reclaimable: usage.buildCache.reclaimable,
      });
    } catch (err) {
      log.error(`Failed to read build cache usage: ${err}`);
      return NextResponse.json({ size: null, reclaimable: null });
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/admin/maintenance/build-cache — prunes the build cache and returns the space reclaimed.
async function handlePost() {
  try {
    await requireAppAdmin();

    log.info("pruning build cache");
    const { spaceReclaimed } = await pruneBuildCache(undefined, { all: true });
    log.info(`build cache prune reclaimed ${spaceReclaimed} bytes`);

    return NextResponse.json({ ok: true, reclaimed: spaceReclaimed });
  } catch (error) {
    return handleRouteError(error, "build-cache prune");
  }
}

export const POST = withRateLimit(handlePost, { tier: "critical", key: "maintenance:build-cache" });
