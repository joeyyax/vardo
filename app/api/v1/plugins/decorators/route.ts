import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getEnabledPlugins } from "@/lib/plugins/registry";

/**
 * GET /api/v1/plugins/decorators?target=project.header.title
 *
 * Returns decorator declarations from all enabled plugins for a given target.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");
  if (!target) {
    return NextResponse.json({ error: "target parameter required" }, { status: 400 });
  }

  const plugins = await getEnabledPlugins();

  const decorators = plugins
    .filter((p) => p.ui?.decorators?.[target])
    .map((p) => ({
      pluginId: p.id,
      position: p.ui!.decorators![target]!.position,
      component: p.ui!.decorators![target]!.component,
      props: p.ui!.decorators![target]!.props,
    }));

  return NextResponse.json({ decorators });
}
