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
 * Used during onboarding so a new instance can inherit config from an existing one.
 * Authenticated via mesh bearer token (WireGuard + token hash).
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
