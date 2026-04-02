import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "../auth";
import { registerListApps } from "./list-apps";
import { registerGetAppStatus } from "./get-app-status";
import { registerGetAppLogs } from "./get-app-logs";
import { registerListProjects } from "./list-projects";
import { registerCreateProject } from "./create-project";
import { registerCreatePreview } from "./create-preview";
import { registerListPreviews } from "./list-previews";
import { registerGetPreviewStatus } from "./get-preview-status";
import { registerGetPreviewUrl } from "./get-preview-url";
import { registerDestroyPreview } from "./destroy-preview";
import { registerGetDeployLogs } from "./get-deploy-logs";
import { registerDeployApp } from "./deploy-app";
import { registerGetDeployStatus } from "./get-deploy-status";
import { registerGetAppConfig } from "./get-app-config";
import { registerUpdateApp } from "./update-app";
import { registerGetEnvVars } from "./get-env-vars";
import { registerSetEnvVars } from "./set-env-vars";
import { registerRestartApp } from "./restart-app";
import { registerStopApp } from "./stop-app";
import { registerRollbackApp } from "./rollback-app";
import { registerAdoptApp } from "./adopt-app";

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
  registerCreateProject(server, context);
  registerCreatePreview(server, context);
  registerListPreviews(server, context);
  registerGetPreviewStatus(server, context);
  registerGetPreviewUrl(server, context);
  registerDestroyPreview(server, context);
  registerGetDeployLogs(server, context);
  registerDeployApp(server, context);
  registerGetDeployStatus(server, context);
  registerGetAppConfig(server, context);
  registerUpdateApp(server, context);
  registerGetEnvVars(server, context);
  registerSetEnvVars(server, context);
  registerRestartApp(server, context);
  registerStopApp(server, context);
  registerRollbackApp(server, context);
  registerAdoptApp(server, context);
}
