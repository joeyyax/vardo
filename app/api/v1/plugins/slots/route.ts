import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getEnabledPlugins } from "@/lib/plugins/registry";
import type { SlotLocation } from "@/lib/plugins/manifest";

/**
 * GET /api/v1/plugins/slots?location=app.detail.tabs
 *
 * Returns slot declarations from all enabled plugins for a given location.
 * Used by the PluginSlots client component to render plugin UI.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const location = url.searchParams.get("location") as SlotLocation | null;
  if (!location) {
    return NextResponse.json({ error: "location parameter required" }, { status: 400 });
  }

  const plugins = await getEnabledPlugins();

  const slots = plugins
    .filter((p) => p.ui?.slots?.[location])
    .map((p) => ({
      pluginId: p.id,
      component: p.ui!.slots![location]!.component,
      props: p.ui!.slots![location]!.props,
    }));

  return NextResponse.json({ slots });
}
