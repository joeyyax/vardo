import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { invitationPreview, loadInvitePage } from "@/lib/app-services/invitations";
import { InviteAcceptClient } from "./invite-accept-client";
import { acceptInvitation } from "./actions";

type Props = {
  params: Promise<{ token: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;

  const preview = await invitationPreview(token);

  if (!preview) {
    return { title: "Invalid invitation" };
  }

  const { orgName } = preview;

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
  if (!(await isFeatureEnabledAsync("teams"))) notFound();

  const { token } = await params;

  const invitation = await loadInvitePage(token);

  if (!invitation) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <div className="w-full max-w-md text-center space-y-3">
          <h1 className="type-h1">Invalid invitation</h1>
          <p className="text-muted-foreground">
            This invitation link is invalid or has been removed.
          </p>
        </div>
      </div>
    );
  }

  if (invitation.expired) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <div className="w-full max-w-md text-center space-y-3">
          <h1 className="type-h1">Invitation expired</h1>
          <p className="text-muted-foreground">
            This invitation link has expired. Ask your team admin to send a new one.
          </p>
        </div>
      </div>
    );
  }

  const session = await getSession();

  // Auto-accept when the signed-in email matches.
  if (session?.user?.id && session.user.email === invitation.email) {
    if (invitation.status === "accepted") {
      redirect("/projects");
    }

    // Accept via server action (token stays server-side)
    await acceptInvitation(token);
  }

  if (invitation.status === "accepted") {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <div className="w-full max-w-md text-center space-y-3">
          <h1 className="type-h1">Already accepted</h1>
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
      orgName={invitation.orgName}
      inviterName={invitation.inviterName}
      isLoggedIn={!!session?.user?.id}
      loggedInEmail={session?.user?.email ?? undefined}
      acceptAction={acceptInvitation.bind(null, token)}
    />
  );
}
