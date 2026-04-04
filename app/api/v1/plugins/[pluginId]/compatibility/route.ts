import { NextResponse } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { checkPluginCompatibility } from "@/lib/plugins/compatibility";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { plugins } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/**
 * GET /api/v1/plugins/[pluginId]/compatibility
 *
 * Returns the compatibility check result for a specific plugin.
 * Lets the admin UI surface issues before the user clicks "Enable".
 * Admin only.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ pluginId: string }> },
) {
  try {
    await requireAppAdmin();

    const { pluginId } = await params;

    const plugin = await db.query.plugins.findFirst({
      where: eq(plugins.id, pluginId),
    });
    if (!plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }

    const result = await checkPluginCompatibility(pluginId);

    return NextResponse.json(result);
  } catch (error) {
    return handleRouteError(error);
  }
}
