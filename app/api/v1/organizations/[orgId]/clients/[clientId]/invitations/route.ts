import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientInvitations, clients, INVITATION_ROLES, DEFAULT_INVITATION_VISIBILITY, type InvitationRole, type InvitationVisibility } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

type RouteParams = {
  params: Promise<{ orgId: string; clientId: string }>;
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

// GET /api/v1/organizations/[orgId]/clients/[clientId]/invitations
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const invitations = await db.query.clientInvitations.findMany({
      where: eq(clientInvitations.clientId, clientId),
      orderBy: (inv, { desc }) => [desc(inv.createdAt)],
    });

    return NextResponse.json(invitations);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching client invitations:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/clients/[clientId]/invitations
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId, clientId } = await params;
    const { organization, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const client = await verifyClientBelongsToOrg(clientId, orgId);
    if (!client) {
      return NextResponse.json({ error: "Client not found" }, { status: 404 });
    }

    const body = await request.json();
    const { email, role, visibility } = body;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const invitationRole: InvitationRole = INVITATION_ROLES.includes(role) ? role : "viewer";
    const invitationVisibility: InvitationVisibility = {
      ...DEFAULT_INVITATION_VISIBILITY,
      ...(visibility && typeof visibility === "object" ? visibility : {}),
    };

    // Check if invitation already exists for this email/client
    const existingInvitation = await db.query.clientInvitations.findFirst({
      where: and(
        eq(clientInvitations.clientId, clientId),
        eq(clientInvitations.email, normalizedEmail)
      ),
    });

    if (existingInvitation) {
      const [updated] = await db
        .update(clientInvitations)
        .set({
          role: invitationRole,
          visibility: invitationVisibility,
          invitedBy: session.user.id,
          token: nanoid(32),
          sentAt: null,
          acceptedAt: null,
          userId: null,
        })
        .where(eq(clientInvitations.id, existingInvitation.id))
        .returning();

      return NextResponse.json(updated);
    }

    const token = nanoid(32);

    const [invitation] = await db
      .insert(clientInvitations)
      .values({
        clientId,
        email: normalizedEmail,
        role: invitationRole,
        visibility: invitationVisibility,
        invitedBy: session.user.id,
        token,
      })
      .returning();

    // Mark as sent immediately (TODO: actual email sending via Resend)
    await db
      .update(clientInvitations)
      .set({ sentAt: new Date() })
      .where(eq(clientInvitations.id, invitation.id));

    return NextResponse.json({ ...invitation, sentAt: new Date() }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating client invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
