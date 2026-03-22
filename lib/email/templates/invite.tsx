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
};

export function InviteEmail({ email }: InviteEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>You've been invited to Host</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>You've been invited to Host</Heading>
          <Text style={text}>
            An account has been created for <strong>{email}</strong>. You can
            sign in using a magic link — just enter your email on the login page
            and check your inbox.
          </Text>
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
