import { monitorCollectionRoutes } from "@/lib/uptime/route-handlers";
import { orgScope } from "@/lib/uptime/route-scopes";

export const { GET, POST } = monitorCollectionRoutes(orgScope, "organizations-uptime");
