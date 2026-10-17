import { monitorItemRoutes } from "@/lib/uptime/route-handlers";
import { instanceScope } from "@/lib/uptime/route-scopes";

export const { GET, PATCH, DELETE } = monitorItemRoutes(instanceScope, "admin-uptime");
