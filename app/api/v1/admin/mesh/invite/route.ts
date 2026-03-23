import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { createInvite } from "@/lib/mesh/invite";
import { z } from "zod";

const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ENDPOINT_RE = /^[\w.\-]+:\d{1,5}$/;

const createInviteSchema = z.object({
  publicKey: z.string().regex(WG_KEY_RE, "Invalid WireGuard public key"),
  endpoint: z.string().regex(ENDPOINT_RE, "Invalid endpoint (expected host:port)"),
  internalIp: z.string().regex(IP_RE, "Invalid IP address"),
});

/** POST /api/v1/admin/mesh/invite — generate an invite code for a new peer */
export async function POST(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const parsed = createInviteSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0].message },
        { status: 400 }
      );
    }

    const code = await createInvite(parsed.data);

    return NextResponse.json({ code }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Error creating mesh invite");
  }
}
