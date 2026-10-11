import { getProbeGuardSettings } from "@/lib/probe-guard/instance";
import { renderConsoleRobots } from "@/lib/probe-guard/robots";
import { DEFAULT_INSTANCE_PROBE_GUARD } from "@/lib/probe-guard/settings";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const settings = await getProbeGuardSettings().catch(() => DEFAULT_INSTANCE_PROBE_GUARD);
  return new Response(renderConsoleRobots(settings), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
}
