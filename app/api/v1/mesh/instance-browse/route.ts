import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { browse, BrowseError, browseRequestSchema, INSTANCE_BROWSE_PATH } from "@/lib/instances/browse";

/** POST /api/v1/mesh/instance-browse — read-only orgs, projects and apps for the user a linked instance names. */
async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, INSTANCE_BROWSE_PATH, 4096);
    if ("response" in call) return call.response;

    const parsed = browseRequestSchema.safeParse(call.json);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
    }

    return NextResponse.json(await browse(call.peer, parsed.data));
  } catch (error) {
    if (error instanceof BrowseError) return NextResponse.json({ error: error.message }, { status: error.status });
    return handleRouteError(error, "Error answering an instance browse request");
  }
}

export const POST = withRateLimit(handlePost, { tier: "read", key: "mesh-instance-browse" });
