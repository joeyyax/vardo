import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireMeshPeer } from "@/lib/mesh/auth";
import {
  getEmailProviderConfig,
  getBackupStorageConfig,
  getGitHubAppConfig,
  getFeatureFlagsConfig,
  getSslConfig,
} from "@/lib/system-settings";

/**
 * GET /api/v1/mesh/config — return shareable config to authenticated mesh peers.
 *
 * Authenticated via mesh bearer token. Returns the hub's current configuration
 * for email, backup storage, GitHub app, feature flags, and SSL so that spoke
 * instances can stay in sync without manual duplication.
 */
export async function GET(request: NextRequest) {
  try {
    await requireMeshPeer(request);

    const [email, backup, github, features, ssl] = await Promise.all([
      getEmailProviderConfig(),
      getBackupStorageConfig(),
      getGitHubAppConfig(),
      getFeatureFlagsConfig(),
      getSslConfig(),
    ]);

    return NextResponse.json({
      email,
      backup,
      github,
      features,
      ssl,
    });
  } catch (error) {
    return handleRouteError(error, "Error fetching mesh config");
  }
}
