import { NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { stampAllAppDirOwners, summarizeAppDirOwners } from "@/lib/docker/app-dir-owner";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:app-dir-owners");

// GET /api/v1/admin/maintenance/app-dir-owners — ownership coverage of $VARDO_HOME/apps, read-only.
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json(await stampAllAppDirOwners({ dryRun: true }));
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/admin/maintenance/app-dir-owners — stamps unmarked app directories with the app claiming each name.
// Returns coverage and the directories it couldn't resolve.
async function handlePost() {
  try {
    await requireAppAdmin();

    const report = await stampAllAppDirOwners();
    log.info(summarizeAppDirOwners(report));

    return NextResponse.json(report);
  } catch (error) {
    return handleRouteError(error, "app-dir-owner stamp");
  }
}

export const POST = withRateLimit(handlePost, {
  tier: "critical",
  key: "maintenance:app-dir-owners",
});

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/maintenance/app-dir-owners" });
