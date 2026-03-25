import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "./auth";
import { registerAllTools } from "./tools";

/**
 * Create a configured MCP server instance with all tools registered.
 *
 * Each request gets a fresh instance — stateless by design.
 */
export function createMcpServer(context: McpAuthContext): McpServer {
  const server = new McpServer({
    name: "vardo",
    version: "1.0.0",
  });

  registerAllTools(server, context);

  return server;
}
