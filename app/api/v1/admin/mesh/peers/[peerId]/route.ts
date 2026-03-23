import { NextResponse } from "next/server";
import { handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { db } from "@/lib/db";
import { meshPeers, projectInstances } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

/** DELETE /api/v1/admin/mesh/peers/[peerId] — remove a peer from the mesh */
export async function DELETE(
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
