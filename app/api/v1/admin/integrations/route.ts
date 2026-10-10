import { NextResponse } from "next/server";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { issueCopy } from "@/lib/integrations/issues";
import { listOpenIssues, runIntegrationCheck } from "@/lib/integrations/check";
import { logger } from "@/lib/logger";

const log = logger.child("integration-check");

async function payload() {
  const issues = await listOpenIssues();
  return issues.map((issue) => ({ ...issue, copy: issueCopy(issue) }));
}

// GET — every open integration permission issue across orgs.
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json({ issues: await payload() });
  } catch (error) {
    return handleRouteError(error, "Error reading integration issues");
  }
}

// POST — re-reads permissions from each provider now.
async function handlePost() {
  try {
    await requireAppAdmin();
    try {
      await runIntegrationCheck();
    } catch (err) {
      log.warn(`permission check failed: ${err instanceof Error ? err.message : err}`);
      return NextResponse.json({ error: "Couldn't reach GitHub. Try again in a minute." }, { status: 502 });
    }
    const issues = await payload();
    return NextResponse.json({
      issues,
      message: issues.length ? "Still waiting on GitHub." : "All permissions are in place.",
    });
  } catch (error) {
    return handleRouteError(error, "Error checking integration permissions");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/integrations" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "post:v1/admin/integrations" });
