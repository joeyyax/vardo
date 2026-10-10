import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "./auth";
import { collectTools } from "./registry";
import { dispatchTool, instanceParam } from "./dispatch";
import { registerListInstances } from "./tools/list-instances";

/** Creates a fresh MCP server with all tools registered, one per request. Each tool takes an optional instance. */
export function createMcpServer(context: McpAuthContext): McpServer {
  const server = new McpServer({
    name: "vardo",
    version: "1.0.0",
  });

  for (const def of collectTools(context).values()) {
    server.tool(def.name, def.description, { ...def.shape, instance: instanceParam }, (args, extra) =>
      dispatchTool(context, def, args as Record<string, unknown>, extra)
    );
  }
  registerListInstances(server, context);

  return server;
}
