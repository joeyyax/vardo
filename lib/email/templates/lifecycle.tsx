import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

interface LifecycleEmailProps {
  organizationName: string;
  clientName: string;
  projectName: string;
  heading: string;
  previewText: string;
  /** Body paragraphs — each string becomes a <Text> block */
  paragraphs: string[];
  ctaLabel?: string;
  ctaUrl?: string;
  signOff?: string;
}

export function LifecycleEmail({
  organizationName,
  clientName,
  projectName,
  heading: headingText,
  previewText,
  paragraphs,
  ctaLabel,
  ctaUrl,
  signOff,
}: LifecycleEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Org name badge */}
          <Section style={header}>
            <Text style={headerText}>{organizationName}</Text>
          </Section>

          {/* Heading */}
          <Heading style={h1}>{headingText}</Heading>
          <Text style={subtitle}>{projectName}</Text>

          <Hr style={hr} />

          {/* Greeting + Body */}
          <Text style={greeting}>Hi {clientName},</Text>
          {paragraphs.map((paragraph, i) => (
            <Text key={i} style={body}>
              {paragraph}
            </Text>
          ))}

          {/* CTA */}
          {ctaLabel && ctaUrl && (
            <Section style={ctaSection}>
              <Button style={button} href={ctaUrl}>
                {ctaLabel}
              </Button>
            </Section>
          )}

          <Hr style={hr} />

          {/* Sign-off */}
          <Text style={signOffStyle}>
            {signOff || `— ${organizationName}`}
          </Text>

          {/* Footer */}
          <Section style={footer}>
            <Text style={footerText}>
              You&apos;re receiving this because you&apos;re involved in{" "}
              {projectName} with {organizationName}.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

// Styles — matches existing invoice/report templates
const main = {
  backgroundColor: "#f6f9fc",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
};

const container = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  padding: "40px 20px",
  maxWidth: "560px",
};

const header = {
  marginBottom: "32px",
};

const headerText = {
  fontSize: "12px",
  fontWeight: "600",
  color: "#6b7280",
  textTransform: "uppercase" as const,
  letterSpacing: "0.5px",
  margin: "0",
};

const h1 = {
  fontSize: "24px",
  fontWeight: "700",
  color: "#111827",
  margin: "0 0 8px 0",
};

const subtitle = {
  fontSize: "16px",
  color: "#374151",
  margin: "0",
};

const hr = {
  borderColor: "#e5e7eb",
  margin: "24px 0",
};

const greeting = {
  fontSize: "15px",
  color: "#111827",
  lineHeight: "1.6",
  margin: "0 0 16px 0",
};

const body = {
  fontSize: "15px",
  color: "#374151",
  lineHeight: "1.6",
  margin: "0 0 16px 0",
};

const ctaSection = {
  textAlign: "center" as const,
  padding: "8px 0 16px",
};

const button = {
  backgroundColor: "#0f172a",
  borderRadius: "8px",
  color: "#ffffff",
  fontSize: "14px",
  fontWeight: "600",
  textDecoration: "none",
  textAlign: "center" as const,
  display: "inline-block",
  padding: "12px 24px",
};

const signOffStyle = {
  fontSize: "15px",
  color: "#111827",
  fontWeight: "500" as const,
  margin: "0 0 8px 0",
};

const footer = {
  marginTop: "32px",
};

const footerText = {
  fontSize: "12px",
  color: "#9ca3af",
  margin: "0 0 4px 0",
  textAlign: "center" as const,
};

export default LifecycleEmail;
