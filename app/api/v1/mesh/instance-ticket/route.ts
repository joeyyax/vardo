import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { readSignedMeshCall } from "@/lib/mesh/signed-request";
import { INSTANCE_TICKET_PATH, issueTicket, TicketError, ticketRequestSchema } from "@/lib/instances/ticket";

/** POST /api/v1/mesh/instance-ticket — a single-use sign-in ticket for the user a linked instance names. */
async function handlePost(request: NextRequest) {
  try {
    const call = await readSignedMeshCall(request, INSTANCE_TICKET_PATH, 4096);
    if ("response" in call) return call.response;

    const parsed = ticketRequestSchema.safeParse(call.json);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
    }

    return NextResponse.json(await issueTicket(call.peer, parsed.data));
  } catch (error) {
    if (error instanceof TicketError) return NextResponse.json({ error: error.message }, { status: error.status });
    return handleRouteError(error, "Error issuing an instance sign-in ticket");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "mesh-instance-ticket" });
