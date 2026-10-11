import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { allowEntryPatchSchema } from "@/lib/probe-guard/allowlist";
import { removeAllowEntry, updateAllowEntry } from "@/lib/probe-guard/allowlist-actions";

type RouteParams = { params: Promise<{ entryId: string }> };

/** PATCH — changes an entry's note or guard skip. */
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { entryId } = await params;
    const parsed = allowEntryPatchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    const entry = await updateAllowEntry(entryId, parsed.data);
    if (!entry) return apiError.notFound("entry");
    return NextResponse.json({ entry });
  } catch (error) {
    return handleRouteError(error, "Error changing an allowlist entry");
  }
}

/** DELETE — removes an entry. */
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const { entryId } = await params;
    if (!(await removeAllowEntry(entryId))) return apiError.notFound("entry");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error removing an allowlist entry");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "admin-probe-guard-allowlist-patch" });
export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "admin-probe-guard-allowlist-delete" });
