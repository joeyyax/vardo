import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { invalidatePublicTrust } from "@/lib/trust/public-load";
import { addSubprocessor } from "@/lib/trust/subprocessor-store";
import { buildTrustView } from "@/lib/trust/view";

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().min(1).max(160),
    region: z.string().trim().max(80).nullish(),
  })
  .strict();

/** POST — adds a subprocessor by hand. It's confirmed, since the operator wrote it. */
async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    await addSubprocessor({ ...parsed.data, region: parsed.data.region || null });
    invalidatePublicTrust();
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error adding subprocessor");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-trust-subprocessors" });
