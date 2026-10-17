import { monitorMuteRoutes } from "@/lib/uptime/route-handlers";
import { instanceScope } from "@/lib/uptime/route-scopes";

export const { POST } = monitorMuteRoutes(instanceScope, "admin-uptime-mute");
