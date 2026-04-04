import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getPluginSetting, setPluginSetting } from "@/lib/plugins/registry";
import { getPlugin } from "@/lib/plugins/registry";

/**
 * GET /api/v1/plugins/settings?pluginId=backups&organizationId=xxx
 *
 * Returns current settings for a plugin.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const pluginId = url.searchParams.get("pluginId");
  if (!pluginId) {
    return NextResponse.json({ error: "pluginId required" }, { status: 400 });
  }

  const organizationId = url.searchParams.get("organizationId") ?? undefined;

  const plugin = getPlugin(pluginId);
  if (!plugin?.ui?.settings) {
    return NextResponse.json({ settings: {} });
  }

  const settings: Record<string, string> = {};
  for (const field of plugin.ui.settings) {
    const value = await getPluginSetting(pluginId, field.key, organizationId);
    settings[field.key] = value ?? String(field.default ?? "");
  }

  return NextResponse.json({ settings });
}

/**
 * PUT /api/v1/plugins/settings
 * Body: { pluginId, organizationId?, settings: { key: value, ... } }
 *
 * Save plugin settings.
 */
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { pluginId, organizationId, settings } = body as {
    pluginId: string;
    organizationId?: string;
    settings: Record<string, string>;
  };

  if (!pluginId || !settings) {
    return NextResponse.json({ error: "pluginId and settings required" }, { status: 400 });
  }

  for (const [key, value] of Object.entries(settings)) {
    await setPluginSetting(pluginId, key, value, organizationId);
  }

  return NextResponse.json({ success: true });
}
