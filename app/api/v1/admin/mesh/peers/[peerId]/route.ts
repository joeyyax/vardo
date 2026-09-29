import { NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { meshPeers, organizations, projectInstances } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

import { withRateLimit } from "@/lib/api/with-rate-limit";

/** DELETE /api/v1/admin/mesh/peers/[peerId] — remove a peer from the mesh */
async function handleDelete(
  _request: Request,
  { params }: { params: Promise<{ peerId: string }> }
) {
  try {
    await requireAppAdmin();

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

const patchSchema = z.object({
  organizationId: z.string().min(1).nullable(),
}).strict();

/** PATCH /api/v1/admin/mesh/peers/[peerId] — bind a peer to the org its transfers act in */
async function handlePatch(
  request: Request,
  { params }: { params: Promise<{ peerId: string }> }
) {
  try {
    await requireAppAdmin();

    const { peerId } = await params;
    const parsed = patchSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 }
      );
    }

    const { organizationId } = parsed.data;
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
      .set({ organizationId, updatedAt: new Date() })
      .where(eq(meshPeers.id, peerId))
      .returning({ id: meshPeers.id, organizationId: meshPeers.organizationId });

    if (!peer) {
      return NextResponse.json({ error: "Peer not found" }, { status: 404 });
    }

    return NextResponse.json({ peer });
  } catch (error) {
    return handleRouteError(error, "Error updating mesh peer");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "mesh-peers" });
