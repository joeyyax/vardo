import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { actOnRollout, isRolloutCoordinator } from "@/lib/self-update/coordinator";
import { getRollout } from "@/lib/self-update/store";

const actionSchema = z.object({
  action: z.enum(["immediate", "skip", "retry"]),
  rolloutId: z.string().min(1),
  instanceId: z.string().min(1).optional(),
}).strict();

async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json({ rollout: await getRollout(), coordinator: await isRolloutCoordinator() });
  } catch (error) {
    return handleRouteError(error);
  }
}

async function handlePost(request: NextRequest) {
  try {
    const session = await requireAppAdmin();
    if (session.authMethod !== "session") return NextResponse.json({ error: "Sign in to manage the rollout" }, { status: 403 });
    if (!(await isRolloutCoordinator())) return NextResponse.json({ error: "Manage rollouts on the mesh hub" }, { status: 409 });
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: "Invalid rollout action" }, { status: 400 });
    const { action, rolloutId, instanceId } = parsed.data;
    const rollout = await actOnRollout(action, rolloutId, session.user.id, instanceId);
    return NextResponse.json({ rollout });
  } catch (error) {
    if (error instanceof Error && /rollout|instance|busy/i.test(error.message)) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return handleRouteError(error);
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "admin-update-rollout" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-update-rollout-action" });
