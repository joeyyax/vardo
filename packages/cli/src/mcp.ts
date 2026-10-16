import type { Instance } from "./config";
import type { Tool } from "./schema";

/** A failed request to the console; exits 1. */
export class CallError extends Error {}

export type Content = { type: string; text?: string; mimeType?: string; [key: string]: unknown };

export type ToolResult = {
  content?: Content[];
  structuredContent?: unknown;
  isError?: boolean;
  [key: string]: unknown;
};

export type RpcOptions = { fetch?: typeof fetch; userAgent?: string };

type RpcMessage = { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };

/** Every JSON message in a text/event-stream body. */
export function parseSse(body: string): unknown[] {
  const messages: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.trim()) messages.push(JSON.parse(data));
  }
  return messages;
}

/** Sends one JSON-RPC request to the console's /api/mcp and returns its result. */
export async function rpc(target: Instance, method: string, params: Record<string, unknown>, opts: RpcOptions = {}): Promise<unknown> {
  const host = new URL(target.url).host;
  const id = 1;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(`${target.url}/api/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(opts.userAgent && { "User-Agent": opts.userAgent }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
  } catch (err) {
    const cause = (err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message;
    throw new CallError(`Can't reach ${host}: ${cause}`);
  }

  const body = await res.text();
  if (res.status === 401) throw new CallError(`${host} rejected the token. Run \`vardo login ${target.url}\` again.`);
  if (!res.ok) {
    let detail = body.slice(0, 200).trim();
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {}
    throw new CallError(`${host} answered ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  let messages: RpcMessage[];
  try {
    messages = (res.headers.get("content-type")?.includes("text/event-stream") ? parseSse(body) : [JSON.parse(body)]) as RpcMessage[];
  } catch {
    throw new CallError(`${host} sent a response the CLI can't read.`);
  }
  const reply = messages.find((m) => m && m.id === id) ?? messages.at(-1);
  if (!reply) throw new CallError(`${host} sent an empty response.`);
  if (reply.error) throw new CallError(reply.error.message ?? `JSON-RPC error ${reply.error.code}`);
  return reply.result;
}

export async function listTools(target: Instance, opts?: RpcOptions): Promise<Tool[]> {
  const result = (await rpc(target, "tools/list", {}, opts)) as { tools?: Tool[] };
  return result?.tools ?? [];
}

export async function callTool(
  target: Instance,
  name: string,
  args: Record<string, unknown>,
  opts?: RpcOptions,
): Promise<ToolResult> {
  return (await rpc(target, "tools/call", { name, arguments: args }, opts)) as ToolResult;
}
