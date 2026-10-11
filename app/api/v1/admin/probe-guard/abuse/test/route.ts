import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getAbuseApiKey } from "@/lib/probe-guard/abuse-store";
import { getReporter } from "@/lib/probe-guard/reporting/registry";

const bodySchema = z.object({ apiKey: z.string().trim().min(1).max(200).optional() }).strict();

/** POST — checks a key, the one sent or the stored one, against a documentation address. */
async function handlePost(request: NextRequest) {
  try {
    await requireAdminAuth(request);
    const parsed = bodySchema.safeParse((await request.json().catch(() => null)) ?? {});
    if (!parsed.success) return apiError.validation(parsed.error);
    const key = parsed.data.apiKey ?? (await getAbuseApiKey());
    if (!key) return NextResponse.json({ ok: false, error: "Add an AbuseIPDB API key first." }, { status: 400 });
    const result = await getReporter()!.testKey(key);
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  } catch (error) {
    return handleRouteError(error, "Error testing the AbuseIPDB key");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-probe-guard-abuse-test" });
