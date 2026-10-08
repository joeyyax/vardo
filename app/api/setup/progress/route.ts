import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { needsSetup } from "@/lib/setup";
import { requireAdminAuth } from "@/lib/auth/admin";
import {
  getEmailProviderConfig,
  getBackupStorageConfig,
  getGitHubAppConfig,
  getInstanceConfig,
} from "@/lib/system-settings";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { apiError } from "@/lib/api/error-response";

// GET /api/setup/progress — returns completion status for each setup step.
// Unauthenticated during setup (no user exists yet); requires admin after.
async function handleGet(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  const setup = await needsSetup();

  if (!setup) {
    try {
      await requireAdminAuth();
    } catch {
      return apiError.unauthorized();
    }
  }

  const [emailConfig, backupConfig, githubConfig, instanceConfig, peerCount] =
    await Promise.all([
      getEmailProviderConfig(),
      getBackupStorageConfig(),
      getGitHubAppConfig(),
      getInstanceConfig(),
      db
        .select({ count: sql<number>`count(*)` })
        .from(meshPeers)
        .then(([r]) => Number(r.count)),
    ]);

  return NextResponse.json({
    account: !setup,
    email: emailConfig !== null,
    backup: backupConfig !== null,
    github: githubConfig !== null,
    domain: Boolean(instanceConfig.baseDomain),
    instances: peerCount > 0,
  });
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/progress" });
