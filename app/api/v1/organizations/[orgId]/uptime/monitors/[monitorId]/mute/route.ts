import { monitorMuteRoutes } from "@/lib/uptime/route-handlers";
import { orgScope } from "@/lib/uptime/route-scopes";

export const { POST } = monitorMuteRoutes(orgScope, "organizations-uptime-mute");
