import { NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getBuildCacheUsage, pruneBuildCache } from "@/lib/docker/client";
import { getBuildKitCacheUsage, pruneBuildKitCache } from "@/lib/docker/buildkit";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:build-cache");

// GET /api/v1/admin/maintenance/build-cache — build cache size and reclaimable space, the daemon's plus BuildKit's.
// Both are null (unknown) on failure, never 0.
async function handleGet() {
  try {
    await requireAppAdmin();

    try {
      const [usage, buildkit] = await Promise.all([getBuildCacheUsage(), getBuildKitCacheUsage()]);
      return NextResponse.json({
        size: usage.totalSize + (buildkit?.totalSize ?? 0),
        reclaimable: usage.reclaimable + (buildkit?.reclaimable ?? 0),
      });
    } catch (err) {
      log.error(`Failed to read build cache usage: ${err}`);
      return NextResponse.json({ size: null, reclaimable: null });
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/admin/maintenance/build-cache — prunes the daemon's and BuildKit's build cache and returns the space reclaimed.
async function handlePost() {
  try {
    await requireAppAdmin();

    log.info("pruning build cache");
    const [{ spaceReclaimed: daemon }, buildkit] = await Promise.all([
      pruneBuildCache(undefined, { all: true }),
      pruneBuildKitCache().catch((err) => {
        log.error(`BuildKit cache prune failed: ${err}`);
        return 0;
      }),
    ]);
    const spaceReclaimed = daemon + buildkit;
    log.info(`build cache prune reclaimed ${spaceReclaimed} bytes`);

    return NextResponse.json({ ok: true, reclaimed: spaceReclaimed });
  } catch (error) {
    return handleRouteError(error, "build-cache prune");
  }
}

export const POST = withRateLimit(handlePost, { tier: "critical", key: "maintenance:build-cache" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/maintenance/build-cache" });
