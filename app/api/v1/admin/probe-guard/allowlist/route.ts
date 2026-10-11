import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { allowEntryInputSchema } from "@/lib/probe-guard/allowlist";
import { getAllowlist } from "@/lib/probe-guard/allowlist-store";
import { AllowlistError, addAllowEntry } from "@/lib/probe-guard/allowlist-actions";

/** GET — the never-ban list. */
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json({ entries: await getAllowlist() });
  } catch (error) {
    return handleRouteError(error, "Error reading the allowlist");
  }
}

/** POST — adds an entry and lifts any active ban it covers. */
async function handlePost(request: NextRequest) {
  try {
    const session = await requireAppAdmin();
    const parsed = allowEntryInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    const result = await addAllowEntry(parsed.data, session.user.id);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof AllowlistError) return NextResponse.json({ error: error.message }, { status: 400 });
    if (error instanceof ZodError) return apiError.validation(error);
    return handleRouteError(error, "Error adding to the allowlist");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/probe-guard/allowlist" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-probe-guard-allowlist" });
