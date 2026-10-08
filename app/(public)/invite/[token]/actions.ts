"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { invitations } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { eq } from "drizzle-orm";
import { hashInvitationToken } from "@/lib/invitations/token";
import { claimInvitation } from "@/lib/invitations/accept";

export async function acceptInvitation(token: string): Promise<{ error?: string }> {
  if (!(await isFeatureEnabledAsync("teams"))) {
    return { error: "Team management is disabled on this instance" };
  }

  const session = await getSession();

  if (!session?.user?.id) {
    return { error: "Authentication required" };
  }

  const invitation = await db.query.invitations.findFirst({
    where: eq(invitations.tokenHash, hashInvitationToken(token)),
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

  if (!(await claimInvitation(invitation, session.user.id))) {
    return { error: "This invitation is no longer valid" };
  }

  redirect("/projects");
}
