import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { COMMITMENT_IDS, commitmentDef, validAmount } from "@/lib/trust/commitments";
import { invalidatePublicTrust } from "@/lib/trust/public-load";
import { setCommitment } from "@/lib/trust/store";
import { buildTrustView } from "@/lib/trust/view";

const patchSchema = z
  .object({
    id: z.enum(COMMITMENT_IDS),
    enabled: z.boolean().optional(),
    amount: z.number().nullable().optional(),
  })
  .strict();

/** PATCH — switches a commitment on or off, or sets the value of one the operator owns. */
async function handlePatch(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    const { id, enabled, amount } = parsed.data;
    const def = commitmentDef(id)!;
    if (amount !== undefined) {
      if (def.derived) return NextResponse.json({ error: "Vardo reads this value from your settings." }, { status: 400 });
      if (amount !== null && !validAmount(def, amount)) {
        return NextResponse.json({ error: `${def.label} must be between ${def.min} and ${def.max}.` }, { status: 400 });
      }
    }
    await setCommitment(id, { ...(enabled !== undefined && { enabled }), ...(amount !== undefined && { amount }) });
    invalidatePublicTrust();
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error saving commitment");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "admin-trust-commitments" });
