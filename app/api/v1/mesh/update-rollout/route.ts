import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { HUB_IP } from "@/lib/mesh/ip-allocator";
import { readPeerReadiness, retryPeerRollout, startPeerRollout } from "@/lib/self-update/rollout-peer";
import { withRateLimit } from "@/lib/api/with-rate-limit";

const PATH = "/api/v1/mesh/update-rollout";
const requestSchema = z.object({
  action: z.enum(["status", "start", "retry"]),
  rolloutId: z.string().min(1).max(128),
  targetSha: z.string().regex(/^[0-9a-f]{40}$/i),
  targetLabel: z.string().min(1).max(120),
  channel: z.enum(["main", "releases"]),
}).strict();

async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, PATH, 2048);
    if ("response" in call) return call.response;
    if (call.peer.internalIp !== HUB_IP) return NextResponse.json({ error: "Only the mesh hub can coordinate updates" }, { status: 403 });
    const parsed = requestSchema.safeParse(call.json);
    if (!parsed.success) return NextResponse.json({ error: "Invalid rollout request" }, { status: 400 });
    const { action, rolloutId, targetSha, targetLabel, channel } = parsed.data;
    const result = action === "status"
      ? await readPeerReadiness(targetSha, channel, rolloutId)
      : action === "start"
        ? await startPeerRollout(targetSha, targetLabel, channel, rolloutId)
        : await retryPeerRollout(targetSha, channel, rolloutId);
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Couldn't check update readiness");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "mesh-update-rollout" });
