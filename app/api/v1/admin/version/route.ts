import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { getVersionData } from "@/lib/version";

// GET /api/v1/admin/version
export async function GET() {
  try {
    await requireAppAdmin();
    const data = await getVersionData();
    return NextResponse.json(data);
  } catch (error) {
    return handleRouteError(error, "Error checking version");
  }
}
