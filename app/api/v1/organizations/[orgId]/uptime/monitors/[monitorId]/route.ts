import { monitorItemRoutes } from "@/lib/uptime/route-handlers";
import { orgScope } from "@/lib/uptime/route-scopes";

export const { GET, PATCH, DELETE } = monitorItemRoutes(orgScope, "organizations-uptime");
