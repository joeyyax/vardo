import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateRequest } from "@/lib/mcp/auth";
import { createMcpServer } from "@/lib/mcp/server";

import { withRateLimit } from "@/lib/api/with-rate-limit";

/**
 * POST /api/mcp — Streamable HTTP transport for MCP.
 *
 * Handles initialize, tools/list, and tools/call JSON-RPC requests.
 * Stateless: fresh McpServer instance per request, authenticated via
 * Bearer token bound to an organization.
 */
async function handlePost(request: NextRequest) {
  // Check if MCP plugin is enabled
  const { requirePlugin } = await import("@/lib/api/require-plugin");
  const gate = await requirePlugin("mcp");
  if (gate) return gate;

  const context = await authenticateRequest(request);
  if (!context) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const server = createMcpServer(context);

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session persistence
  });

  await server.connect(transport);

  return transport.handleRequest(request);
}

/**
 * GET /api/mcp — SSE endpoint for server-initiated notifications.
 *
 * Required by the MCP Streamable HTTP spec. In stateless mode we reject
 * these since there's no persistent session to attach to.
 */
export async function GET() {
  return new Response(
    JSON.stringify({
      error: "SSE not supported — this server is stateless. Use POST for all requests.",
    }),
    {
      status: 405,
      headers: { "Content-Type": "application/json" },
    },
  );
}

/**
 * DELETE /api/mcp — Session teardown.
 *
 * No-op in stateless mode — each request is independent.
 */
async function handleDelete() {
  return new Response(null, { status: 204 });
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "api-mcp" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "api-mcp" });
