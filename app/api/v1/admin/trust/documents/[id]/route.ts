import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { DPA_ID, DPA_MAX_BYTES, publishDpa, readDpaFile, removeDpa, reviewPolicy, saveDpa, unpublishDpa, unpublishPolicy } from "@/lib/trust/documents";
import { POLICY_IDS, type PolicyId } from "@/lib/trust/policies";
import { invalidatePublicTrust } from "@/lib/trust/public-load";
import { buildTrustView } from "@/lib/trust/view";

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("publish"), body: z.string().trim().min(1).max(30_000).optional() }).strict(),
  z.object({ action: z.literal("unpublish") }).strict(),
]);

const isPolicy = (id: string): id is PolicyId => (POLICY_IDS as readonly string[]).includes(id);
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

/** GET — downloads the uploaded agreement, published or not. */
async function handleGet(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    if ((await params).id !== DPA_ID) return notFound();
    const file = await readDpaFile(false);
    if (!file) return notFound();
    return new NextResponse(new Uint8Array(file), {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="data-processing-agreement.pdf"', "Cache-Control": "no-store" },
    });
  } catch (error) {
    return handleRouteError(error, "Error reading document");
  }
}

/** POST — publishes a document, or takes it off the public page. A policy publishes the text sent with it. */
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    const id = (await params).id;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });
    const input = parsed.data;
    if (id === DPA_ID) {
      if (input.action === "publish") {
        if (!(await publishDpa())) return NextResponse.json({ error: "Upload the agreement first." }, { status: 400 });
      } else await unpublishDpa();
    } else if (isPolicy(id)) {
      if (input.action === "publish") {
        if (!input.body) return NextResponse.json({ error: "The policy text is empty." }, { status: 400 });
        await reviewPolicy(id, input.body);
      } else await unpublishPolicy(id);
    } else return notFound();
    invalidatePublicTrust();
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error saving document");
  }
}

/** PUT — uploads the agreement as a PDF. It stays private until published. */
async function handlePut(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    if ((await params).id !== DPA_ID) return notFound();
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a PDF." }, { status: 400 });
    if (file.size > DPA_MAX_BYTES) return NextResponse.json({ error: "The file is over 10 MB." }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") return NextResponse.json({ error: "The file isn't a PDF." }, { status: 400 });
    await saveDpa(bytes);
    invalidatePublicTrust();
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error uploading document");
  }
}

/** DELETE — removes the uploaded agreement. */
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAdminAuth(request);
    if ((await params).id !== DPA_ID) return notFound();
    await removeDpa();
    invalidatePublicTrust();
    return NextResponse.json(await buildTrustView());
  } catch (error) {
    return handleRouteError(error, "Error removing document");
  }
}

export const GET = withRateLimit(handleGet, { tier: "heavy", key: "get:v1/admin/trust/documents" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-trust-document" });
export const PUT = withRateLimit(handlePut, { tier: "heavy", key: "admin-trust-document-upload" });
export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "admin-trust-document-delete" });
