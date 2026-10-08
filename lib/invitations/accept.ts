import { and, eq, gt } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { invitations, memberships } from "@/lib/db/schema";

type Invitation = typeof invitations.$inferSelect;

/** Claims a pending, unexpired invitation and adds the membership. False when it was revoked, expired or already used. */
export async function claimInvitation(invitation: Invitation, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(invitations)
      .set({ status: "accepted", acceptedAt: new Date() })
      .where(
        and(
          eq(invitations.id, invitation.id),
          eq(invitations.status, "pending"),
          gt(invitations.expiresAt, new Date()),
        ),
      )
      .returning({ id: invitations.id });
    if (!claimed) return false;

    if (invitation.scope === "org" && invitation.targetId) {
      const existing = await tx.query.memberships.findFirst({
        where: and(eq(memberships.organizationId, invitation.targetId), eq(memberships.userId, userId)),
      });
      if (!existing) {
        await tx.insert(memberships).values({
          id: nanoid(),
          userId,
          organizationId: invitation.targetId,
          role: invitation.role,
        });
      }
    }
    return true;
  });
}
