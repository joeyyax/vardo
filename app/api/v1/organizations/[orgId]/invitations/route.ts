import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { handleRouteError } from "@/lib/api/error-response";
import { db } from "@/lib/db";
import { invitations, user } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { sendEmail, emailDelivery } from "@/lib/email/send";
import { InviteEmail } from "@/lib/email/templates/invite";
import { verifyOrgAccess } from "@/lib/api/verify-access";
import { generateInvitationToken, invitationUrl } from "@/lib/invitations/token";
import { requirePlugin } from "@/lib/api/require-plugin";

import { withRateLimit } from "@/lib/api/with-rate-limit";

const createInvitationSchema = z.object({
  email: z.string().email("Invalid email address"),
  role: z.enum(["admin", "member"]).default("member"),
}).strict();

type RouteParams = {
  params: Promise<{ orgId: string }>;
};

// GET /api/v1/organizations/[orgId]/invitations
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.view");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("teams");
    if (gate) return gate;

    const pending = await db.query.invitations.findMany({
      where: and(
        eq(invitations.targetId, orgId),
        eq(invitations.scope, "org"),
      ),
      // Selected explicitly so the token hash is never serialized.
      columns: {
        id: true,
        email: true,
        role: true,
        status: true,
        createdAt: true,
        expiresAt: true,
      },
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
async function handlePost(request: NextRequest, { params }: RouteParams) {
  try {
    const { orgId } = await params;
    const org = await verifyOrgAccess(orgId, "org.members.manage");
    if (!org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const gate = await requirePlugin("teams");
    if (gate) return gate;

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

    // scope and targetId come from the route, never the body.
    const scope = "org";
    const targetId = orgId;

    const inviter = await db.query.user.findFirst({
      where: eq(user.id, org.session.user.id),
      columns: { name: true },
    });

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // One transaction for the duplicate check and insert.
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
          tokenHash: token.hash,
          invitedBy: org.session.user.id,
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

    const inviteUrl = invitationUrl(token.raw);

    const sent = await sendEmail({
      to: normalizedEmail,
      subject: `You've been invited to ${org.organization.name}`,
      template: InviteEmail({
        email: normalizedEmail,
        orgName: org.organization.name,
        inviterName: inviter?.name ?? undefined,
        inviteUrl,
      }),
    });

    const { tokenHash: _hash, ...created } = invitation;
    return NextResponse.json(
      { invitation: { ...created, inviteUrl }, email: emailDelivery(sent) },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error creating invitation");
  }
}

export const POST = withRateLimit(handlePost, { tier: "mutation", key: "organizations-invitations" });
