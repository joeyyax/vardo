import { Heading, Text } from "react-email";
import { EmailLayout, CTA, styles } from "./components";

type VerifyEmailProps = {
  url: string;
  email: string;
};

export function VerifyEmail({ url, email }: VerifyEmailProps) {
  return (
    <EmailLayout preview="Verify your email">
      <Heading style={styles.h1}>Verify your email</Heading>
      <Text style={{ ...styles.text, margin: "0 0 24px" }}>
        Confirm that <strong>{email}</strong> is yours. This link expires in 1
        hour.
      </Text>
      <CTA href={url}>Verify email &rarr;</CTA>
      <Text style={{ ...styles.muted, margin: "24px 0 0" }}>
        If you didn&apos;t request this, you can safely ignore this email.
      </Text>
    </EmailLayout>
  );
}

VerifyEmail.PreviewProps = {
  url: "https://host.example.com/api/auth/verify-email?token=abc123",
  email: "alex@example.com",
} satisfies VerifyEmailProps;

export default VerifyEmail;
