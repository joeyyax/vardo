"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { invitations, memberships } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";

export async function acceptInvitation(token: string): Promise<{ error?: string }> {
  const session = await getSession();

  if (!session?.user?.id) {
    return { error: "Authentication required" };
  }

  const invitation = await db.query.invitations.findFirst({
    where: eq(invitations.token, token),
  });

  if (!invitation) {
    return { error: "Invalid invitation token" };
  }

  if (invitation.status === "accepted") {
    redirect("/projects");
  }

  if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
    return { error: "Invitation has expired" };
  }

  if (session.user.email !== invitation.email) {
    return { error: "This invitation was sent to a different email address" };
  }

  if (invitation.scope === "org" && invitation.targetId) {
    const existingMembership = await db.query.memberships.findFirst({
      where: and(
        eq(memberships.organizationId, invitation.targetId),
        eq(memberships.userId, session.user.id),
      ),
    });

    if (!existingMembership) {
      await db.insert(memberships).values({
        id: nanoid(),
        userId: session.user.id,
        organizationId: invitation.targetId,
        role: invitation.role,
      });
    }
  }

  await db
    .update(invitations)
    .set({
      status: "accepted",
      acceptedAt: new Date(),
    })
    .where(eq(invitations.id, invitation.id));

  redirect("/projects");
}
