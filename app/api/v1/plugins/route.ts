import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { plugins } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { enablePlugin, disablePlugin } from "@/lib/plugins/registry";
import { handleRouteError } from "@/lib/api/error-response";

/**
 * GET /api/v1/plugins — list all registered plugins with their status.
 * Admin only.
 */
export async function GET() {
  try {
    await requireAppAdmin();

    const allPlugins = await db.query.plugins.findMany({
      orderBy: (p, { asc }) => [asc(p.name)],
    });

    return NextResponse.json({
      plugins: allPlugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        category: p.category,
        enabled: p.enabled,
        builtIn: p.builtIn,
        manifest: p.manifest,
        installedAt: p.installedAt,
      })),
    });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * PATCH /api/v1/plugins — enable or disable a plugin.
 * Body: { pluginId, enabled }
 * Admin only.
 */
export async function PATCH(request: NextRequest) {
  try {
    await requireAppAdmin();

    const body = await request.json();
    const { pluginId, enabled } = body as { pluginId: string; enabled: boolean };

    if (!pluginId || typeof enabled !== "boolean") {
      return NextResponse.json({ error: "pluginId and enabled required" }, { status: 400 });
    }

    // Check plugin exists
    const plugin = await db.query.plugins.findFirst({
      where: eq(plugins.id, pluginId),
    });
    if (!plugin) {
      return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    }

    if (enabled) {
      try {
        await enablePlugin(pluginId);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Cannot enable plugin")) {
          return NextResponse.json({ error: err.message }, { status: 422 });
        }
        throw err;
      }
    } else {
      await disablePlugin(pluginId);
    }

    return NextResponse.json({ success: true, pluginId, enabled });
  } catch (error) {
    return handleRouteError(error);
  }
}
