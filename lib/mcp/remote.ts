// Receiving side of a forwarded MCP call: maps the user, rebuilds the scope and runs the tool here.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { memberships, user } from "@/lib/db/schema";
import { recordActivity } from "@/lib/activity";
import { isCapability, type Capability } from "@/lib/auth/permissions";
import { getInstanceDisplayName } from "@/lib/system-settings";
import type { McpAuthContext } from "./auth";
import { collectTools } from "./registry";
import type { PeerRow } from "./instances";
import type { RemoteCall } from "./dispatch";

export class RemoteCallError extends Error {
  constructor(
    message: string,
    public status: 400 | 403 | 404
  ) {
    super(message);
    this.name = "RemoteCallError";
  }
}

type CallingPeer = Pick<PeerRow, "id" | "instanceId" | "name" | "acceptMcp" | "organizationId">;

/** The local user with the same verified email. */
async function mapUser(email: string): Promise<{ id: string } | null> {
  const row = await db.query.user.findFirst({
    where: and(sql`lower(${user.email}) = ${email.toLowerCase()}`, eq(user.emailVerified, true)),
    columns: { id: true },
  });
  return row ?? null;
}

/** The org a forwarded call lands in: the peer's bound org, else the user's first for a cross-org token. */
async function landingOrg(peer: CallingPeer, userId: string, crossOrg: boolean): Promise<string | null> {
  if (peer.organizationId) return peer.organizationId;
  if (!crossOrg) return null;
  const first = await db.query.memberships.findFirst({
    where: eq(memberships.userId, userId),
    columns: { organizationId: true },
    orderBy: [asc(memberships.createdAt)],
  });
  return first?.organizationId ?? null;
}

/** Builds the context a forwarded call runs under. Throws RemoteCallError when the peer or user isn't allowed. */
export async function remoteContext(peer: CallingPeer, call: RemoteCall): Promise<McpAuthContext> {
  const here = (await getInstanceDisplayName()) ?? "this instance";
  if (!peer.acceptMcp) {
    throw new RemoteCallError(`${here} doesn't accept MCP calls from ${peer.name}. An admin there can turn it on.`, 403);
  }

  const mapped = await mapUser(call.user.email);
  if (!mapped) throw new RemoteCallError(`No user with that verified email on ${here}`, 403);

  const organizationId = await landingOrg(peer, mapped.id, call.scope.crossOrg);
  if (!organizationId) {
    throw new RemoteCallError(
      `${here} hasn't bound ${peer.name} to an organization. Bind it there, or use a token with all organizations.`,
      403
    );
  }

  const caps = call.scope.capabilities;
  return {
    userId: mapped.id,
    organizationId,
    crossOrg: call.scope.crossOrg,
    scopes: caps === null ? null : new Set(caps.filter(isCapability) as Capability[]),
    adminScope: call.scope.admin,
    linkedInstances: false,
    via: { peerId: peer.id, instanceId: peer.instanceId, name: peer.name },
  };
}

/** Runs a forwarded tool call here as the mapped user and records it. */
export async function runRemoteCall(peer: CallingPeer, call: RemoteCall, signal: AbortSignal): Promise<CallToolResult> {
  const context = await remoteContext(peer, call);

  const def = collectTools(context).get(call.tool);
  if (!def) throw new RemoteCallError(`Unknown tool ${call.tool}, or this token can't use it here`, 404);

  const args = z.object(def.shape).safeParse(call.arguments);
  if (!args.success) {
    throw new RemoteCallError(args.error.issues[0]?.message ?? "Invalid arguments", 400);
  }

  let result: CallToolResult;
  try {
    result = await def.handler(args.data, { signal });
  } catch (err) {
    result = { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true };
  }

  await recordActivity({
    organizationId: context.organizationId,
    action: "mesh.mcp_received",
    userId: context.userId,
    metadata: {
      tool: call.tool,
      trigger: peer.name,
      peerId: peer.id,
      originInstanceId: peer.instanceId,
      ...(result.isError && { error: "Tool returned an error" }),
    },
  }).catch(() => {});

  return result;
}
