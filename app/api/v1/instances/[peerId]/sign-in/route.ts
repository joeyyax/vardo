import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";
import { getCurrentOrg } from "@/lib/auth/session";
import { instanceUser } from "@/lib/instances/session-user";
import { requestInstanceSignIn, SignInError } from "@/lib/instances/sign-in";

const bodySchema = z
  .object({
    next: z.string().max(512).optional(),
    organizationId: z.string().min(1).max(128).optional(),
  })
  .strict();

/** POST /api/v1/instances/[peerId]/sign-in — a single-use link that signs the current user in on a linked instance. */
async function handlePost(request: NextRequest, { params }: { params: Promise<{ peerId: string }> }) {
  try {
    const who = await instanceUser();
    if ("response" in who) return who.response;

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError.validation(parsed.error);

    const { peerId } = await params;
    const current = await getCurrentOrg();
    const { url } = await requestInstanceSignIn({
      who: who.user,
      peerId,
      next: parsed.data.next,
      organizationId: parsed.data.organizationId,
      activityOrgId: current?.organization.id ?? null,
    });
    return NextResponse.json({ url });
  } catch (error) {
    if (error instanceof SignInError) return NextResponse.json({ error: error.message }, { status: error.status });
    return handleRouteError(error, "Error signing in to a linked instance");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "instance-sign-in" });
