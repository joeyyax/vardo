import { Heading, Text } from "@react-email/components";
import { EmailLayout, CTA, styles } from "./components";

type InviteEmailProps = {
  email: string;
  orgName?: string;
  inviterName?: string;
  inviteUrl?: string;
};

export function InviteEmail({
  email,
  orgName,
  inviterName,
  inviteUrl,
}: InviteEmailProps) {
  const heading = orgName
    ? `You've been invited to ${orgName}`
    : "You've been invited to Host";

  const description = inviterName
    ? `${inviterName} invited you to join ${orgName ? `**${orgName}** on ` : ""}Host.`
    : `An account has been created for ${email}. Sign in using a magic link — just enter your email on the login page and check your inbox.`;

  return (
    <EmailLayout preview={heading}>
      <Heading style={styles.h1}>{heading}</Heading>
      <Text style={{ ...styles.text, margin: "0 0 24px" }}>{description}</Text>
      {inviteUrl && (
        <CTA href={inviteUrl}>Accept invitation &rarr;</CTA>
      )}
      <Text style={{ ...styles.muted, margin: "24px 0 0" }}>
        If you didn&apos;t expect this invitation, you can safely ignore this
        email.
      </Text>
    </EmailLayout>
  );
}

InviteEmail.PreviewProps = {
  email: "newuser@example.com",
  orgName: "Acme Inc",
  inviterName: "Joey Yax",
  inviteUrl: "https://host.example.com/invite/abc123",
} satisfies InviteEmailProps;

export default InviteEmail;
