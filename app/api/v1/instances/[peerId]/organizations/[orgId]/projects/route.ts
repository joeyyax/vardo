import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";
import { instanceUser } from "@/lib/instances/session-user";
import { instanceDirectory } from "@/lib/instances/mesh-directory";
import { VERIFY_EMAIL_HINT } from "@/lib/auth/verify-email-paths";

/** GET /api/v1/instances/[peerId]/organizations/[orgId]/projects — a linked instance's projects and apps, read-only. */
async function handleGet(_request: NextRequest, { params }: { params: Promise<{ peerId: string; orgId: string }> }) {
  try {
    const who = await instanceUser();
    if ("response" in who) return who.response;

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    if (!who.user.emailVerified) {
      return NextResponse.json({ state: "refused", reason: `${VERIFY_EMAIL_HINT} to see your projects there.` });
    }

    const { peerId, orgId } = await params;
    const [peer] = (await instanceDirectory.instances()).filter((p) => p.id === peerId);
    const result = await instanceDirectory.projects(peerId, who.user.email, orgId);
    return NextResponse.json({ instance: peer ?? null, ...result });
  } catch (error) {
    return handleRouteError(error, "Error browsing a linked instance");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "instance-projects" });
