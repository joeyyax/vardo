import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

interface NotificationEmailProps {
  heading: string;
  content: string;
  actionUrl: string;
  actionLabel?: string;
  footerText?: string;
}

export function NotificationEmail({
  heading: headingText,
  content,
  actionUrl,
  actionLabel,
  footerText,
}: NotificationEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{content}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>{headingText}</Heading>
          <Section style={contentBox}>
            <Text style={contentText}>{content}</Text>
          </Section>
          <Section style={buttonContainer}>
            <Button style={button} href={actionUrl}>
              {actionLabel || "View"}
            </Button>
          </Section>
          <Text style={footer}>
            {footerText ||
              "You received this because you're watching this item."}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const main = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "40px 20px",
  maxWidth: "600px",
};

const heading = {
  color: "#111827",
  fontSize: "24px",
  fontWeight: "600",
  lineHeight: "1.3",
  margin: "0 0 8px",
};

const contentBox = {
  backgroundColor: "#f9fafb",
  borderRadius: "8px",
  padding: "24px",
  marginBottom: "24px",
};

const contentText = {
  color: "#111827",
  fontSize: "16px",
  lineHeight: "1.5",
  margin: "0",
};

const buttonContainer = {
  textAlign: "center" as const,
  marginBottom: "32px",
};

const button = {
  backgroundColor: "#111827",
  borderRadius: "8px",
  color: "#fff",
  fontSize: "14px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "inline-block",
  padding: "12px 32px",
};

const footer = {
  color: "#9ca3af",
  fontSize: "14px",
  textAlign: "center" as const,
  margin: "0",
};

export default NotificationEmail;
