import { monitorCollectionRoutes } from "@/lib/uptime/route-handlers";
import { instanceScope } from "@/lib/uptime/route-scopes";

export const { GET, POST } = monitorCollectionRoutes(instanceScope, "admin-uptime");
