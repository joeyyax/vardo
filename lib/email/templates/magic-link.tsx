import { Heading, Text } from "@react-email/components";
import { EmailLayout, CTA, styles } from "./components";

type MagicLinkProps = {
  url: string;
  email: string;
};

export function MagicLinkEmail({ url, email }: MagicLinkProps) {
  return (
    <EmailLayout preview="Sign in to Host">
      <Heading style={styles.h1}>Sign in to Host</Heading>
      <Text style={{ ...styles.text, margin: "0 0 24px" }}>
        Click the link below to sign in as <strong>{email}</strong>. This link
        expires in 15 minutes.
      </Text>
      <CTA href={url}>Sign in to Host &rarr;</CTA>
      <Text style={{ ...styles.muted, margin: "24px 0 0" }}>
        If you didn&apos;t request this, you can safely ignore this email.
      </Text>
    </EmailLayout>
  );
}

MagicLinkEmail.PreviewProps = {
  url: "https://host.example.com/auth/verify?token=abc123",
  email: "joey@example.com",
} satisfies MagicLinkProps;

export default MagicLinkEmail;
