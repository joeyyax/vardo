import { NextResponse, type NextRequest } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { findDetached, measureDetached } from "@/lib/docker/detached-volumes";

// GET /api/v1/admin/maintenance/detached-volumes — volumes and app directories left by deleted apps.
// Names return at once; `?sizes=1` adds sizes, each bounded at 3s.
export async function GET(request: NextRequest) {
  try {
    await requireAppAdmin();

    const found = await findDetached();
    if (request.nextUrl.searchParams.get("sizes") === "1") {
      return NextResponse.json(await measureDetached(found));
    }
    return NextResponse.json(found);
  } catch (error) {
    return handleRouteError(error, "Error listing detached volumes");
  }
}
