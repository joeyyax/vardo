import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { invitations, organizations } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth/session";
import { InviteAcceptClient } from "./invite-accept-client";
import { acceptInvitation } from "./actions";

type Props = {
  params: Promise<{ token: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;

  const invitation = await db.query.invitations.findFirst({
    where: eq(invitations.token, token),
    columns: { targetId: true, scope: true },
  });

  if (!invitation) {
    return { title: "Invalid invitation" };
  }

  let orgName: string | undefined;
  if (invitation.scope === "org" && invitation.targetId) {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, invitation.targetId),
      columns: { name: true },
    });
    orgName = org?.name;
  }

  const title = orgName
    ? `You've been invited to ${orgName}`
    : "You've been invited";
  const description = orgName
    ? `Accept your invitation to join ${orgName} on Vardo.`
    : "Accept your invitation to join a team on Vardo.";

  return {
    title,
    description,
    openGraph: {
      title,
      description,
    },
  };
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params;

  const invitation = await db.query.invitations.findFirst({
    where: eq(invitations.token, token),
    with: {
      inviter: {
        columns: { name: true },
      },
    },
  });

  if (!invitation) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <div className="w-full max-w-md text-center space-y-3">
          <h1 className="text-2xl font-semibold">Invalid invitation</h1>
          <p className="text-muted-foreground">
            This invitation link is invalid or has been removed.
          </p>
        </div>
      </div>
    );
  }

  if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <div className="w-full max-w-md text-center space-y-3">
          <h1 className="text-2xl font-semibold">Invitation expired</h1>
          <p className="text-muted-foreground">
            This invitation link has expired. Ask your team admin to send a new one.
          </p>
        </div>
      </div>
    );
  }

  // Fetch org name for display
  let orgName: string | undefined;
  if (invitation.scope === "org" && invitation.targetId) {
    const org = await db.query.organizations.findFirst({
      where: eq(organizations.id, invitation.targetId),
      columns: { name: true },
    });
    orgName = org?.name;
  }

  const session = await getSession();

  // If user is logged in with the right email, auto-accept
  if (session?.user?.id && session.user.email === invitation.email) {
    if (invitation.status === "accepted") {
      // Already accepted — redirect to org or dashboard
      if (invitation.scope === "org" && invitation.targetId) {
        redirect("/projects");
      }
      redirect("/projects");
    }

    // Accept via server action (token stays server-side)
    await acceptInvitation(token);
  }

  if (invitation.status === "accepted") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <div className="w-full max-w-md text-center space-y-3">
          <h1 className="text-2xl font-semibold">Already accepted</h1>
          <p className="text-muted-foreground">
            This invitation has already been accepted.
          </p>
        </div>
      </div>
    );
  }

  return (
    <InviteAcceptClient
      email={invitation.email}
      orgName={orgName}
      inviterName={invitation.inviter?.name ?? undefined}
      isLoggedIn={!!session?.user?.id}
      loggedInEmail={session?.user?.email ?? undefined}
      acceptAction={acceptInvitation.bind(null, token)}
    />
  );
}
