import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { claimSlotForPeer, ownBuildsBusy, peerSlotToken, releaseSlotForPeer, renewSlotForPeer } from "@/lib/docker/build-gate";
import { meshBuilderStats } from "@/lib/docker/mesh-builder";
import { BUILD_SLOT_PATH, type BuilderReply } from "@/lib/mesh/build-slot";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { UNLINKED_STATUS } from "@/lib/mesh/key-exchange";

const slotSchema = z.object({
  action: z.enum(["claim", "renew", "release", "builder"]),
  token: z.string().regex(/^[A-Za-z0-9-]{1,96}$/),
}).strict();

async function builderReply(): Promise<BuilderReply> {
  const [builder, busy] = await Promise.all([meshBuilderStats(), ownBuildsBusy().catch(() => null)]);
  return busy === null ? { builder } : { builder, busy };
}

/** POST /api/v1/mesh/build-slot — a linked instance's build takes, keeps or gives back a slot in this host's build gate, or reads the isolated builder's OOM kills. */
async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, BUILD_SLOT_PATH, 1024);
    if ("response" in call) return call.response;
    if (!call.peer.acceptBuilds) {
      return NextResponse.json({ error: "This instance doesn't run builds from yours" }, { status: 403 });
    }
    const parsed = slotSchema.safeParse(call.json);
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });

    const token = peerSlotToken(call.peer.id, parsed.data.token);
    switch (parsed.data.action) {
      case "claim":
        return NextResponse.json(await claimSlotForPeer(token));
      case "renew":
        return NextResponse.json({ held: await renewSlotForPeer(token) });
      case "release":
        await releaseSlotForPeer(token);
        return NextResponse.json({ held: false });
      case "builder":
        return NextResponse.json(await builderReply());
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "No link with the calling instance" }, { status: UNLINKED_STATUS });
    }
    return handleRouteError(error, "Error with a mesh build slot");
  }
}

export const POST = withRateLimit(handlePost, { tier: "poll", key: "mesh-build-slot" });
