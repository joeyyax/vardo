import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";

type MagicLinkProps = {
  url: string;
  email: string;
};

export function MagicLinkEmail({ url, email }: MagicLinkProps) {
  return (
    <Html>
      <Head />
      <Preview>Sign in to Host</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Sign in to Host</Heading>
          <Text style={text}>
            Click the button below to sign in as <strong>{email}</strong>.
            This link expires in 10 minutes.
          </Text>
          <Button href={url} style={button}>
            Sign in
          </Button>
          <Text style={meta}>
            If you didn't request this, you can safely ignore this email.
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
const button = {
  backgroundColor: "#d4a574",
  color: "#18181b",
  padding: "12px 24px",
  borderRadius: "8px",
  fontWeight: "600" as const,
  fontSize: "14px",
  textDecoration: "none",
  display: "inline-block" as const,
};
