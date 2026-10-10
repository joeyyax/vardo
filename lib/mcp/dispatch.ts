import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { user } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { meshSignedPost } from "@/lib/mesh/client";
import type { McpAuthContext } from "./auth";
import type { ToolDef, ToolExtra } from "./registry";
import { resolveInstance, type InstanceLabel, type PeerRow } from "./instances";

export const MCP_CALL_PATH = "/api/v1/mesh/mcp-call";

export const instanceParam = z
  .string()
  .optional()
  .describe("Linked instance to run on, by name or id from vardo_list_instances. Defaults to this instance.");

/** What the origin sends a peer: the call, who makes it and the token's scope. The peer's identity comes from its credentials. */
export const remoteCallSchema = z
  .object({
    tool: z.string().min(1).max(100),
    arguments: z.record(z.string(), z.unknown()),
    user: z.object({ email: z.string().email().max(320) }).strict(),
    scope: z
      .object({
        capabilities: z.array(z.string().max(100)).max(200).nullable(),
        crossOrg: z.boolean(),
        admin: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type RemoteCall = z.infer<typeof remoteCallSchema>;

export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Tags a result with the instance it came from, inside JSON object text and in _meta. */
export function labelResult(result: CallToolResult, label: InstanceLabel & { transport?: string }): CallToolResult {
  const instance = { id: label.id, name: label.name, ...(label.transport && { via: label.transport }) };
  const content = result.content.map((item) => {
    if (item.type !== "text") return item;
    try {
      const parsed = JSON.parse(item.text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...item, text: JSON.stringify({ instance, ...parsed }, null, 2) };
      }
    } catch {}
    return { ...item, text: `[${label.name}] ${item.text}` };
  });
  return { ...result, content, _meta: { ...result._meta, "vardo/instance": instance } };
}

/** Runs a tool here or on the linked instance its `instance` argument names. */
export async function dispatchTool(
  context: McpAuthContext,
  def: ToolDef,
  args: Record<string, unknown>,
  extra: ToolExtra
): Promise<CallToolResult> {
  const { instance, ...rest } = args;
  if (instance === undefined || instance === null || instance === "") return def.handler(rest, extra);

  const access = await forwardAccess(context);
  const target = await resolveInstance(instance, { peers: typeof access !== "string" });
  if ("error" in target) return toolError(target.error);
  if (target.kind === "local") return labelResult(await def.handler(rest, extra), target.label);
  if (target.kind === "elsewhere" || typeof access === "string") return toolError(String(access));
  return forwardToolCall(context, access.email, target.peer, def.name, rest);
}

/** Why this token can't act on linked instances, or the email it acts as there. */
async function forwardAccess(context: McpAuthContext): Promise<string | { email: string }> {
  if (context.via) return "A call from a linked instance can't be forwarded again";
  if (!context.linkedInstances) {
    return "This token can't act on linked instances. An instance admin can turn that on for the token in a signed-in session.";
  }
  const row = await db.query.user.findFirst({
    where: eq(user.id, context.userId),
    columns: { email: true, emailVerified: true, isAppAdmin: true },
  });
  if (!row?.isAppAdmin) return "Acting on linked instances needs an instance admin";
  if (!row.emailVerified) return "Verify your email before acting on linked instances";
  return { email: row.email };
}

/** Sends a tool call to a peer over the signed mesh channel and audits it here. The caller checks forwardAccess first. */
async function forwardToolCall(
  context: McpAuthContext,
  email: string,
  peer: Pick<PeerRow, "id" | "name">,
  tool: string,
  args: Record<string, unknown>
): Promise<CallToolResult> {
  const payload: RemoteCall = {
    tool,
    arguments: args,
    user: { email },
    scope: {
      capabilities: context.scopes ? [...context.scopes] : null,
      crossOrg: context.crossOrg,
      admin: context.adminScope === true,
    },
  };

  const audit = (metadata: Record<string, unknown>) =>
    recordActivity({
      organizationId: context.organizationId,
      action: "mesh.mcp_forwarded",
      userId: context.userId,
      metadata: { tool, instance: peer.name, peerId: peer.id, ...metadata },
    }).catch(() => {});

  try {
    const { data, transport } = await meshSignedPost<{ result?: unknown }>(peer.id, MCP_CALL_PATH, payload);
    const raw = data?.result as { content?: unknown } | undefined;
    const parsed = CallToolResultSchema.safeParse(raw);
    if (!parsed.success || !Array.isArray(raw?.content)) {
      await audit({ transport, error: "Malformed result" });
      return toolError(`${peer.name} sent back a malformed result`);
    }
    await audit({ transport, ...(parsed.data.isError && { error: "Tool returned an error" }) });
    return labelResult(parsed.data, { id: peer.id, name: peer.name, local: false, transport });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await audit({ error: message });
    return toolError(`${peer.name}: ${message}`);
  }
}
