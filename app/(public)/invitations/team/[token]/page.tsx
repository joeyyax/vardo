import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { teamInvitations, organizations } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { TeamInvitationAccept } from "./accept-client";

export default async function TeamInvitationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  // Try email invitation first
  let type: "invitation" | "join" = "invitation";
  let orgName: string | null = null;

  const invitation = await db.query.teamInvitations.findFirst({
    where: and(
      eq(teamInvitations.token, token),
      eq(teamInvitations.status, "pending")
    ),
    with: {
      organization: true,
    },
  });

  if (invitation) {
    orgName = invitation.organization.name;
  } else {
    // Try join link
    const org = await db.query.organizations.findFirst({
      where: and(
        eq(organizations.joinToken, token),
        eq(organizations.joinEnabled, true)
      ),
    });

    if (org) {
      type = "join";
      orgName = org.name;
    }
  }

  // Neither found - show error
  if (!orgName) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-md text-center space-y-4">
          <h1 className="text-2xl font-semibold">Invalid Invitation</h1>
          <p className="text-muted-foreground">
            This invitation link is invalid or has expired.
          </p>
        </div>
      </div>
    );
  }

  // Check if user is logged in
  const session = await getSession();

  if (!session?.user?.id) {
    redirect(`/login?callbackUrl=${encodeURIComponent(`/invitations/team/${token}`)}`);
  }

  return (
    <TeamInvitationAccept
      token={token}
      type={type}
      organizationName={orgName}
    />
  );
}
