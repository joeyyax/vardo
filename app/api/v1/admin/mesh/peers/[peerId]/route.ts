import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { meshPeers, organizations, projectInstances } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { requirePlugin } from "@/lib/api/require-plugin";

/** DELETE /api/v1/admin/mesh/peers/[peerId] — remove a peer from the mesh */
async function handleDelete(
  _request: Request,
  { params }: { params: Promise<{ peerId: string }> }
) {
  try {
    await requireAppAdmin();

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    const { peerId } = await params;

    const peer = await db.query.meshPeers.findFirst({
      where: eq(meshPeers.id, peerId),
    });

    if (!peer) {
      return NextResponse.json({ error: "Peer not found" }, { status: 404 });
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(projectInstances)
        .where(eq(projectInstances.meshPeerId, peerId));
      await tx.delete(meshPeers).where(eq(meshPeers.id, peerId));
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error removing mesh peer");
  }
}

export const DELETE = withRateLimit(handleDelete, { tier: "admin", key: "mesh-peers" });

const patchSchema = z
  .object({
    organizationId: z.string().min(1).nullable().optional(),
    acceptMcp: z.boolean().optional(),
  })
  .strict()
  .refine((d) => d.organizationId !== undefined || d.acceptMcp !== undefined, { message: "Nothing to change" });

/** PATCH /api/v1/admin/mesh/peers/[peerId] — bind a peer to an org, or let it forward MCP calls */
async function handlePatch(
  request: Request,
  { params }: { params: Promise<{ peerId: string }> }
) {
  try {
    const session = await requireAppAdmin();

    const gate = await requirePlugin("mesh");
    if (gate) return gate;

    const { peerId } = await params;
    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError.validation(parsed.error, { details: true });
    }

    const { organizationId, acceptMcp } = parsed.data;
    if (acceptMcp !== undefined && session.authMethod !== "session") {
      return NextResponse.json({ error: "Only a signed-in instance admin can change MCP access for a peer" }, { status: 403 });
    }
    if (organizationId) {
      const org = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
        columns: { id: true },
      });
      if (!org) {
        return NextResponse.json({ error: "Organization not found" }, { status: 404 });
      }
    }

    const [peer] = await db
      .update(meshPeers)
      .set({ organizationId, acceptMcp, updatedAt: new Date() })
      .where(eq(meshPeers.id, peerId))
      .returning({ id: meshPeers.id, organizationId: meshPeers.organizationId, acceptMcp: meshPeers.acceptMcp });

    if (!peer) {
      return NextResponse.json({ error: "Peer not found" }, { status: 404 });
    }

    return NextResponse.json({ peer });
  } catch (error) {
    return handleRouteError(error, "Error updating mesh peer");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "mesh-peers" });
