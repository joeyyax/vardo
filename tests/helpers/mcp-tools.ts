import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "@/lib/mcp/auth";

export type ToolResult = { isError?: boolean; content: { text: string }[] };
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** The handlers a register function adds to a stand-in server, by tool name. */
export function captureTools(
  register: (server: McpServer, context: McpAuthContext) => void,
  context: McpAuthContext,
): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = { tool: (name: string, ...rest: unknown[]) => tools.set(name, rest.at(-1) as ToolHandler) };
  register(server as unknown as McpServer, context);
  return tools;
}

export const toolBody = (result: ToolResult) => JSON.parse(result.content[0].text);

export const plainContext = { userId: "u1", organizationId: "org-1", crossOrg: false } as McpAuthContext;
export const adminContext = { ...plainContext, adminScope: true } as McpAuthContext;

/** A drizzle select chain that resolves to `rows` and records the limit it was given. */
export function selectChain(rows: unknown[], calls: { limit?: number[] } = {}) {
  const chain: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) chain[method] = () => chain;
  chain.limit = (n: number) => {
    calls.limit?.push(n);
    return chain;
  };
  chain.then = (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}
