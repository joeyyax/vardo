import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { invitations, user } from "@/lib/db/schema";
import { requireOrg } from "@/lib/auth/session";
import { requireAdmin } from "@/lib/auth/permissions";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import crypto from "crypto";
import { sendEmail } from "@/lib/email/send";
import { InviteEmail } from "@/lib/email/templates/invite";

const createInvitationSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["admin", "member"]).default("member"),
}).strict();

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/invitations
// List pending invitations for the org
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const pending = await db.query.invitations.findMany({
      where: and(
        eq(invitations.targetId, orgId),
        eq(invitations.scope, "org"),
      ),
      with: {
        inviter: {
          columns: { id: true, name: true, email: true },
        },
      },
      orderBy: (t, { desc }) => [desc(t.createdAt)],
    });

    return NextResponse.json({ invitations: pending });
  } catch (error) {
    return handleRouteError(error, "Error fetching invitations");
  }
}

// POST /api/v1/organizations/[orgId]/invitations
// Create an invitation and send an email
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const { organization, membership, session } = await requireOrg();

    if (organization.id !== orgId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    requireAdmin(membership.role);

    const body = await request.json();
    const parsed = createInvitationSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
        { status: 400 },
      );
    }

    const { email, role } = parsed.data;
    const normalizedEmail = email.trim().toLowerCase();

    // scope and targetId are always derived from the route — never from the request body
    const scope = "org";
    const targetId = orgId;

    // Fetch inviter name for the email (outside transaction — read-only)
    const inviter = await db.query.user.findFirst({
      where: eq(user.id, session.user.id),
      columns: { name: true },
    });

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Duplicate check and insert are wrapped in a transaction to prevent races
    const invitation = await db.transaction(async (tx) => {
      const existing = await tx.query.invitations.findFirst({
        where: and(
          eq(invitations.email, normalizedEmail),
          eq(invitations.targetId, orgId),
          eq(invitations.scope, "org"),
          eq(invitations.status, "pending"),
        ),
      });

      if (existing) {
        return null;
      }

      const [created] = await tx
        .insert(invitations)
        .values({
          id: nanoid(),
          email: normalizedEmail,
          scope,
          targetId,
          role,
          token,
          invitedBy: session.user.id,
          expiresAt,
        })
        .returning();

      return created;
    });

    if (!invitation) {
      return NextResponse.json(
        { error: "A pending invitation already exists for this email" },
        { status: 409 }
      );
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const inviteUrl = `${appUrl}/invite/${token}`;

    await sendEmail({
      to: normalizedEmail,
      subject: `You've been invited to ${organization.name}`,
      template: InviteEmail({
        email: normalizedEmail,
        orgName: organization.name,
        inviterName: inviter?.name ?? undefined,
        inviteUrl,
      }),
    });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error creating invitation");
  }
}
