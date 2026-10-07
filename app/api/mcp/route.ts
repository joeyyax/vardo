import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateRequest } from "@/lib/mcp/auth";
import { createMcpServer } from "@/lib/mcp/server";

import { withRateLimit } from "@/lib/api/with-rate-limit";

/** POST /api/mcp — stateless Streamable HTTP transport, authenticated by an org-bound bearer token. */
async function handlePost(request: NextRequest) {
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

/** GET /api/mcp — rejected, since stateless mode has no session for SSE. */
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

/** DELETE /api/mcp — no-op in stateless mode. */
async function handleDelete() {
  return new Response(null, { status: 204 });
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "api-mcp" });
export const DELETE = withRateLimit(handleDelete, { tier: "mutation", key: "api-mcp" });
