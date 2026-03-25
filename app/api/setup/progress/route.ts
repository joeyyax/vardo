import { NextResponse } from "next/server";
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

// GET /api/setup/progress — returns completion status for each setup step.
// Unauthenticated during setup (no user exists yet); requires admin after.
export async function GET() {
  const setup = await needsSetup();

  if (!setup) {
    try {
      await requireAdminAuth();
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
