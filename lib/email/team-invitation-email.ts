import { LifecycleEmail } from "./templates/lifecycle";

type TeamInvitationEmailParams = {
  organizationName: string;
  invitedByName: string;
  inviteUrl: string;
  role: string;
};

/**
 * Email sent when someone is invited to join an organization.
 */
export function teamInvitationEmail(params: TeamInvitationEmailParams) {
  const { organizationName, invitedByName, inviteUrl, role } = params;
  const roleLabel = role === "admin" ? "an admin" : "a team member";

  return {
    subject: `${invitedByName} invited you to join ${organizationName}`,
    react: LifecycleEmail({
      organizationName,
      clientName: "",
      projectName: "",
      heading: "You're Invited",
      previewText: `${invitedByName} invited you to join ${organizationName}`,
      paragraphs: [
        `${invitedByName} has invited you to join ${organizationName} as ${roleLabel}.`,
        "Click the link below to accept the invitation and get started.",
        "This invitation expires in 30 days.",
      ],
      ctaLabel: "Accept Invitation",
      ctaUrl: inviteUrl,
    }),
  };
}
