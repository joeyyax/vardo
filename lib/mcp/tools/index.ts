import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "../auth";
import { registerListApps } from "./list-apps";
import { registerGetAppStatus } from "./get-app-status";
import { registerGetAppLogs } from "./get-app-logs";
import { registerListProjects } from "./list-projects";

/**
 * Register all MCP tools on the server instance.
 */
export function registerAllTools(
  server: McpServer,
  context: McpAuthContext
) {
  registerListApps(server, context);
  registerGetAppStatus(server, context);
  registerGetAppLogs(server, context);
  registerListProjects(server, context);
}
