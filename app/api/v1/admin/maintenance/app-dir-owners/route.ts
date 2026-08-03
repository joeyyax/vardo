import { NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { stampAllAppDirOwners, summarizeAppDirOwners } from "@/lib/docker/app-dir-owner";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:app-dir-owners");

// GET /api/v1/admin/maintenance/app-dir-owners
//
// Surveys ownership coverage across $VARDO_HOME/apps without writing anything.
export async function GET() {
  try {
    await requireAppAdmin();
    return NextResponse.json(await stampAllAppDirOwners({ dryRun: true }));
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/admin/maintenance/app-dir-owners
//
// Stamps every unmarked app directory with the app that claims its name and
// returns the coverage, naming each directory it could not resolve.
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
