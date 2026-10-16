import { NextRequest, NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requestHost } from "@/lib/trust/domains";
import { renderPreview, servePublicTrust } from "@/lib/trust/public-load";

export const dynamic = "force-dynamic";

const SECURITY = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const HTML = { "Content-Type": "text/html; charset=utf-8", ...SECURITY };

// GET /api/public/trust: Traefik rewrites /trust to this on the trust domain. Anywhere else it's a 404.
// ?preview=1 is for admins and shows the page as it would publish.
async function handleGet(request: NextRequest) {
  try {
    if (request.nextUrl.searchParams.has("preview")) {
      await requireAdminAuth(request);
      return new NextResponse(await renderPreview(), { headers: { ...HTML, "Cache-Control": "no-store" } });
    }
    const html = await servePublicTrust(requestHost(request.headers));
    if (!html) return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
    return new NextResponse(html, { headers: { ...HTML, "Cache-Control": "public, max-age=60, stale-while-revalidate=300" } });
  } catch (error) {
    return handleRouteError(error, "Error reading trust page");
  }
}

export const GET = withRateLimit(handleGet, { tier: "public", key: "get:public/trust" });
