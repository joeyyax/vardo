import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { teamInvitations, memberships } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { sendEmail } from "@/lib/email/send";
import { teamInvitationEmail } from "@/lib/email/team-invitation-email";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/team-invitations
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const invitations = await db.query.teamInvitations.findMany({
      where: and(
        eq(teamInvitations.organizationId, orgId),
        eq(teamInvitations.status, "pending")
      ),
      with: {
        inviter: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: (inv, { desc }) => [desc(inv.createdAt)],
    });

    return NextResponse.json({ invitations });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error fetching team invitations:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// POST /api/v1/organizations/[orgId]/team-invitations
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const { email, role = "member" } = body;

    // Validate email
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json({ error: "Valid email is required" }, { status: 400 });
    }

    // Validate role
    if (role !== "admin" && role !== "member") {
      return NextResponse.json({ error: "Role must be 'admin' or 'member'" }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email is already a member of this org
    const existingMembers = await db.query.memberships.findMany({
      where: eq(memberships.organizationId, orgId),
      with: {
        user: { columns: { email: true } },
      },
    });

    const alreadyMember = existingMembers.some(
      (m) => m.user.email.toLowerCase() === normalizedEmail
    );

    if (alreadyMember) {
      return NextResponse.json(
        { error: "This email is already a member of the organization" },
        { status: 409 }
      );
    }

    // Check for existing pending invitation
    const existingInvitation = await db.query.teamInvitations.findFirst({
      where: and(
        eq(teamInvitations.organizationId, orgId),
        eq(teamInvitations.email, normalizedEmail),
        eq(teamInvitations.status, "pending")
      ),
    });

    if (existingInvitation) {
      return NextResponse.json(
        { error: "A pending invitation already exists for this email" },
        { status: 409 }
      );
    }

    // Create invitation
    const token = nanoid(32);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    const [invitation] = await db
      .insert(teamInvitations)
      .values({
        organizationId: orgId,
        email: normalizedEmail,
        role,
        invitedBy: session.user.id,
        token,
        status: "pending",
        expiresAt,
      })
      .returning();

    // Send invitation email
    const inviteUrl = `${process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"}/invitations/team/${token}`;

    await sendEmail(
      {
        ...teamInvitationEmail({
          organizationName: organization.name,
          invitedByName: session.user.name || session.user.email,
          inviteUrl,
          role,
        }),
        to: normalizedEmail,
      },
      {
        organizationId: orgId,
        entityType: "invitation",
        entityId: invitation.id,
      }
    );

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "No organization found") {
      return NextResponse.json({ error: "No organization found" }, { status: 404 });
    }
    console.error("Error creating team invitation:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
