import { NextResponse } from "next/server";
import { handleSelf, isPayload } from "@/lib/metadata/handler";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/internal/metadata/v1/self — reached only through the metadata proxy (docs/metadata-endpoint.md).
export async function GET(request: Request) {
  const result = await handleSelf(request.headers);
  if (isPayload(result)) return NextResponse.json(result.body, { headers: NO_STORE });
  return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
}
