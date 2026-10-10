import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invitations, organizations } from "@/lib/db/schema";
import { hashInvitationToken } from "@/lib/invitations/token";

// The raw token is the credential here, so these take no actor.

async function orgName(invitation: { scope: string; targetId: string | null }) {
  if (invitation.scope !== "org" || !invitation.targetId) return undefined;
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, invitation.targetId),
    columns: { name: true },
  });
  return org?.name;
}

/** The invitation a token names, as stored. Null for an unknown token. */
export async function findInvitationByToken(token: string) {
  return (
    (await db.query.invitations.findFirst({
      where: eq(invitations.tokenHash, hashInvitationToken(token)),
    })) ?? null
  );
}

/** Org name for the invite link's preview. Null for an unknown token; undefined name for a non-org invite. */
export async function invitationPreview(token: string) {
  const invitation = await db.query.invitations.findFirst({
    where: eq(invitations.tokenHash, hashInvitationToken(token)),
    columns: { targetId: true, scope: true },
  });
  if (!invitation) return null;
  return { orgName: await orgName(invitation) };
}

/** What the invite page shows for a token. Null for an unknown token. */
export async function loadInvitePage(token: string) {
  const invitation = await db.query.invitations.findFirst({
    where: eq(invitations.tokenHash, hashInvitationToken(token)),
    columns: { email: true, status: true, expiresAt: true, scope: true, targetId: true },
    with: { inviter: { columns: { name: true } } },
  });
  if (!invitation) return null;
  return {
    email: invitation.email,
    status: invitation.status,
    expired: invitation.status === "expired" || invitation.expiresAt < new Date(),
    scope: invitation.scope,
    targetId: invitation.targetId,
    orgName: await orgName(invitation),
    inviterName: invitation.inviter?.name ?? undefined,
  };
}
