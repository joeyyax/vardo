import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "../auth";
import { registerListApps } from "./list-apps";
import { registerGetAppStatus } from "./get-app-status";
import { registerGetAppLogs } from "./get-app-logs";
import { registerListProjects } from "./list-projects";
import { registerCreatePreview } from "./create-preview";
import { registerListPreviews } from "./list-previews";
import { registerGetPreviewStatus } from "./get-preview-status";
import { registerGetPreviewUrl } from "./get-preview-url";
import { registerDestroyPreview } from "./destroy-preview";
import { registerGetDeployLogs } from "./get-deploy-logs";

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
  registerCreatePreview(server, context);
  registerListPreviews(server, context);
  registerGetPreviewStatus(server, context);
  registerGetPreviewUrl(server, context);
  registerDestroyPreview(server, context);
  registerGetDeployLogs(server, context);
}
