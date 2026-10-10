import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "../auth";
import { listInstances } from "../instances";
import { canActOnLinkedInstances } from "../scope";

export function registerListInstances(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_instances",
    "List this Vardo instance and the instances linked to it, with name, URL, type, canary role, version, health and online status. Pass a name or id as any tool's instance argument to run it there. A token without linked-instance access sees only this instance.",
    {},
    async () => {
      const includePeers = await canActOnLinkedInstances(context);
      const instances = await listInstances({ includePeers });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                instances,
                ...(!includePeers && { note: "This token can't act on linked instances, so they aren't listed" }),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
