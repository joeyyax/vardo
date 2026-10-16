import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { invalidatePublicTrust } from "@/lib/trust/public-load";
import { removeSubprocessor, updateSubprocessor } from "@/lib/trust/subprocessor-store";
import { buildTrustView } from "@/lib/trust/view";

type RouteParams = { params: Promise<{ id: string }> };

const UUID = z.string().uuid();

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().min(1).max(160),
    region: z.string().trim().max(80).nullable(),
    status: z.enum(["suggested", "confirmed", "dismissed"]),
  })
  .partial()
  .strict();

/** PATCH — edits a subprocessor or sets its status. Confirming is what puts it on the public page. */
async function handlePatch(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const id = UUID.safeParse((await params).id);
    if (!id.success) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const parsed = patchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    const patch = { ...parsed.data, ...(parsed.data.region === "" && { region: null }) };
    if (!(await updateSubprocessor(id.data, patch))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    invalidatePublicTrust();
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error saving subprocessor");
  }
}

/** DELETE — removes a subprocessor from the page. */
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const id = UUID.safeParse((await params).id);
    if (!id.success || !(await removeSubprocessor(id.data))) return NextResponse.json({ error: "Not found" }, { status: 404 });
    invalidatePublicTrust();
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error removing subprocessor");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "admin-trust-subprocessor" });
export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "admin-trust-subprocessor-delete" });
