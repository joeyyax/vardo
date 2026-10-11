import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { getInstanceDisplayName } from "@/lib/system-settings";
import { instanceUser } from "@/lib/instances/session-user";
import { instanceDirectory } from "@/lib/instances/mesh-directory";
import { VERIFY_EMAIL_HINT } from "@/lib/auth/verify-email-paths";
import type { DirectoryResult, RemoteOrg } from "@/lib/instances/directory";

/** GET /api/v1/instances — this instance and each linked one that opted in, with the current user's orgs there. */
async function handleGet() {
  try {
    const who = await instanceUser();
    if ("response" in who) return who.response;

    const local = { name: (await getInstanceDisplayName()) ?? "This instance" };
    if (!(await isFeatureEnabledAsync("mesh"))) return NextResponse.json({ local, instances: [] });

    const peers = await instanceDirectory.instances();
    const instances = await Promise.all(
      peers.map(async (peer) => {
        let organizations: DirectoryResult<RemoteOrg[]> | null = null;
        if (peer.browse) {
          organizations = who.user.emailVerified
            ? await instanceDirectory.organizations(peer.id, who.user.email)
            : { state: "refused", reason: `${VERIFY_EMAIL_HINT} to see your organizations there.` };
        }
        return { ...peer, organizations };
      }),
    );

    return NextResponse.json({ local, instances });
  } catch (error) {
    return handleRouteError(error, "Error listing linked instances");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "instances" });
