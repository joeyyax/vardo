import { NextRequest, NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requestHost } from "@/lib/trust/domains";
import { readDpaFile } from "@/lib/trust/documents";
import { isPublicOn } from "@/lib/trust/public-load";

export const dynamic = "force-dynamic";

// GET /api/public/trust/dpa: Traefik rewrites /trust/dpa.pdf to this on the trust domain. Anywhere else it's a 404.
async function handleGet(request: NextRequest) {
  try {
    const none = () => new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    if (!(await isPublicOn(requestHost(request.headers)))) return none();
    const file = await readDpaFile(true);
    if (!file) return none();
    return new NextResponse(new Uint8Array(file), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="data-processing-agreement.pdf"',
        "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (error) {
    return handleRouteError(error, "Error reading trust document");
  }
}

export const GET = withRateLimit(handleGet, { tier: "public", key: "get:public/trust/dpa" });
