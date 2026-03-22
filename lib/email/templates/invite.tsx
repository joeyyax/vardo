import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";

type InviteEmailProps = {
  email: string;
  tempPassword: string;
};

export function InviteEmail({ email, tempPassword }: InviteEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>You've been invited to Host</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>You've been invited to Host</Heading>
          <Text style={text}>
            An account has been created for <strong>{email}</strong>. Sign in
            with the temporary password below, then change it in your profile
            settings.
          </Text>
          <Text style={codeBlock}>{tempPassword}</Text>
          <Text style={meta}>
            If you didn't expect this invitation, you can safely ignore this
            email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = { backgroundColor: "#18181b", fontFamily: "system-ui, sans-serif" };
const container = { maxWidth: "480px", margin: "40px auto", padding: "24px" };
const h1 = { color: "#fafafa", fontSize: "20px", fontWeight: "600" as const, margin: "0 0 16px" };
const text = { color: "#a1a1aa", fontSize: "14px", lineHeight: "24px" };
const meta = { color: "#71717a", fontSize: "12px", lineHeight: "20px", marginTop: "24px" };
const codeBlock = {
  backgroundColor: "#27272a",
  color: "#fafafa",
  padding: "12px 16px",
  borderRadius: "8px",
  fontFamily: "monospace",
  fontSize: "16px",
  letterSpacing: "1px",
  textAlign: "center" as const,
};
