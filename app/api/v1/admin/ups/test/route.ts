import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { probeNutServer, upsConnectionSchema } from "@/lib/ups/probe";
import { getUpsServer, targetOf } from "@/lib/ups/store";

const testSchema = upsConnectionSchema.extend({
  /** Tests with this server's stored password when none is given. */
  serverId: z.string().optional(),
});

/** POST /api/v1/admin/ups/test — the UPSes a NUT server lists, with their status */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = testSchema.safeParse(await request.json());
    if (!parsed.success) return apiError.validation(parsed.error);
    const { serverId, ...target } = parsed.data;

    let password = target.password ?? null;
    if (password === null && serverId) {
      const stored = await getUpsServer(serverId);
      if (stored) password = targetOf(stored).password ?? null;
    }

    const result = await probeNutServer({ ...target, password });
    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error, "Error testing NUT server");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-ups-test" });
