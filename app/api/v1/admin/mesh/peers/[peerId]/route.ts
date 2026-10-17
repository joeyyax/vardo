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

    // Its SSH key and builder port stop working here and its WireGuard peer goes.
    await import("@/lib/mesh/ssh-endpoint").then(({ syncAuthorizedKeys }) => syncAuthorizedKeys()).catch(() => {});
    await import("@/lib/mesh/builder-forward").then(({ reconcileBuilderForward }) => reconcileBuilderForward()).catch(() => {});
    await import("@/lib/mesh/wireguard")
      .then(async ({ isWireguardRunning, rebuildAndSync }) => (await isWireguardRunning()) && rebuildAndSync())
      .catch(() => {});

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
    acceptWebhookRelay: z.boolean().optional(),
    acceptInstanceSignin: z.boolean().optional(),
    acceptInstanceBrowse: z.boolean().optional(),
    acceptBuilds: z.boolean().optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), { message: "Nothing to change" });

/** Toggles only a signed-in instance admin may change, with the refusal for each. */
const SESSION_ONLY = {
  acceptMcp: "Only a signed-in instance admin can change MCP access for a peer",
  acceptWebhookRelay: "Only a signed-in instance admin can change webhook relays for a peer",
  acceptInstanceSignin: "Only a signed-in instance admin can change instance sign-in for a peer",
  acceptInstanceBrowse: "Only a signed-in instance admin can change instance browsing for a peer",
  acceptBuilds: "Only a signed-in instance admin can change builds for a peer",
} as const;

/** PATCH /api/v1/admin/mesh/peers/[peerId] — bind a peer to an org or change what it may do here */
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

    const { organizationId, acceptMcp, acceptWebhookRelay, acceptInstanceSignin, acceptInstanceBrowse, acceptBuilds } = parsed.data;
    if (session.authMethod !== "session") {
      for (const [key, error] of Object.entries(SESSION_ONLY)) {
        if (parsed.data[key as keyof typeof SESSION_ONLY] !== undefined) {
          return NextResponse.json({ error }, { status: 403 });
        }
      }
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
      // Turning builds off stops renewing the peer's builder certificate.
      .set({ organizationId, acceptMcp, acceptWebhookRelay, acceptInstanceSignin, acceptInstanceBrowse, acceptBuilds, ...(acceptBuilds === false && { builderCert: null }), updatedAt: new Date() })
      .where(eq(meshPeers.id, peerId))
      .returning({
        id: meshPeers.id,
        organizationId: meshPeers.organizationId,
        acceptMcp: meshPeers.acceptMcp,
        acceptWebhookRelay: meshPeers.acceptWebhookRelay,
        acceptInstanceSignin: meshPeers.acceptInstanceSignin,
        acceptInstanceBrowse: meshPeers.acceptInstanceBrowse,
        acceptBuilds: meshPeers.acceptBuilds,
      });

    if (!peer) {
      return NextResponse.json({ error: "Peer not found" }, { status: 404 });
    }

    if (acceptBuilds !== undefined) {
      await import("@/lib/mesh/ssh-endpoint").then(({ syncAuthorizedKeys }) => syncAuthorizedKeys()).catch(() => {});
      await import("@/lib/mesh/builder-forward").then(({ reconcileBuilderForward }) => reconcileBuilderForward()).catch(() => {});
    }

    // Tells the peer now rather than at its next heartbeat.
    if (acceptWebhookRelay !== undefined || acceptInstanceSignin !== undefined || acceptInstanceBrowse !== undefined || acceptBuilds !== undefined) {
      import("@/lib/mesh/heartbeat")
        .then(({ sendHeartbeatToPeer }) => sendHeartbeatToPeer(peerId))
        .then(() => (acceptBuilds !== undefined ? import("@/lib/mesh/ssh-exchange").then((m) => m.exchangeSshKeys(peerId, { force: true })) : undefined))
        .catch(() => {});
    }

    return NextResponse.json({ peer });
  } catch (error) {
    return handleRouteError(error, "Error updating mesh peer");
  }
}

export const PATCH = withRateLimit(handlePatch, { tier: "admin", key: "mesh-peers" });
