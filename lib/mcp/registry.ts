import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { McpAuthContext } from "./auth";
import { registerAllTools } from "./tools";

export type ToolExtra = { signal: AbortSignal };

export type ToolHandler = (args: Record<string, unknown>, extra: ToolExtra) => CallToolResult | Promise<CallToolResult>;

export type ToolDef = {
  name: string;
  description: string;
  shape: ZodRawShape;
  handler: ToolHandler;
};

/** Every tool registerAllTools would register for `context`, keyed by name. */
export function collectTools(context: McpAuthContext): Map<string, ToolDef> {
  const tools = new Map<string, ToolDef>();
  const collector = {
    tool: (...args: unknown[]) => {
      const [name, description, shape, handler] = args;
      if (
        args.length !== 4 ||
        typeof name !== "string" ||
        typeof description !== "string" ||
        !shape ||
        typeof shape !== "object" ||
        typeof handler !== "function"
      ) {
        throw new Error(`MCP tool ${String(name)} must be registered as tool(name, description, shape, handler)`);
      }
      tools.set(name, { name, description, shape: shape as ZodRawShape, handler: handler as ToolHandler });
    },
  };
  registerAllTools(collector as unknown as McpServer, context);
  return tools;
}
