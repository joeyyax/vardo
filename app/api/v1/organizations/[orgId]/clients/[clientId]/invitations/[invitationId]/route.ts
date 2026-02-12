import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientInvitations, clients } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string; invitationId: string }>;
};

async function verifyClientBelongsToOrg(clientId: string, orgId: string) {
  const client = await db.query.clients.findFirst({
    where: and(
      eq(clients.id, clientId),
      eq(clients.organizationId, orgId)
    ),
  });
  return client;
}

// GET /api/v1/organizations/[orgId]/clients/[clientId]/invitations/[invitationId]
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, invitationId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const invitation = await db.query.clientInvitations.findFirst({
      where: and(
        eq(clientInvitations.id, invitationId),
        eq(clientInvitations.clientId, clientId)
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    return NextResponse.json(invitation);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching client invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// DELETE /api/v1/organizations/[orgId]/clients/[clientId]/invitations/[invitationId]
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, invitationId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const invitation = await db.query.clientInvitations.findFirst({
      where: and(
        eq(clientInvitations.id, invitationId),
        eq(clientInvitations.clientId, clientId)
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    await db
      .delete(clientInvitations)
      .where(eq(clientInvitations.id, invitationId));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error deleting client invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// PATCH /api/v1/organizations/[orgId]/clients/[clientId]/invitations/[invitationId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId, invitationId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const invitation = await db.query.clientInvitations.findFirst({
      where: and(
        eq(clientInvitations.id, invitationId),
        eq(clientInvitations.clientId, clientId)
      ),
    });

    if (!invitation) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
    }

    const body = await request.json();
    const { role, visibility, resend } = body;

    const updateData: Record<string, unknown> = {};

    if (role !== undefined) {
      updateData.role = role;
    }

    if (visibility !== undefined) {
      updateData.visibility = {
        ...invitation.visibility,
        ...visibility,
      };
    }

    if (resend) {
      updateData.sentAt = null;
      updateData.invitedBy = session.user.id;
    }

    const [updated] = await db
      .update(clientInvitations)
      .set(updateData)
      .where(eq(clientInvitations.id, invitationId))
      .returning();

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error updating client invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
