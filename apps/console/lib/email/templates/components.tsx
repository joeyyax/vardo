import {
  Body,
  Button,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactNode } from "react";

// ---------------------------------------------------------------------------
// Design tokens (inline styles for email compatibility)
// ---------------------------------------------------------------------------

const fontFamily =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

const monoFamily =
  '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function EmailLayout({
  preview,
  children,
}: {
  preview: string;
  children: ReactNode;
}) {
  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          backgroundColor: "#fafafa",
          fontFamily,
        }}
      >
        <Container
          style={{
            maxWidth: "480px",
            margin: "40px auto",
            padding: "40px 32px",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
          }}
        >
          <Text
            style={{
              fontSize: "16px",
              fontWeight: "600",
              color: "#1a1a1a",
              margin: "0 0 32px",
            }}
          >
            Vardo
          </Text>
          {children}
          <Hr style={{ borderColor: "#eeeeee", margin: "32px 0 24px" }} />
          <Text style={{ color: "#b0b0b0", fontSize: "12px", margin: "0" }}>
            Sent by Vardo
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

// ---------------------------------------------------------------------------
// CTA button
// ---------------------------------------------------------------------------

export function CTA({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: "#1a1a1a",
        color: "#ffffff",
        padding: "12px 24px",
        borderRadius: "6px",
        fontWeight: "500",
        fontSize: "14px",
        textDecoration: "none",
        display: "inline-block",
      }}
    >
      {children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Semantic boxes
// ---------------------------------------------------------------------------

function BoxWrapper({
  bg,
  border,
  children,
}: {
  bg: string;
  border: string;
  children: ReactNode;
}) {
  return (
    <Section
      style={{
        backgroundColor: bg,
        borderRadius: "6px",
        padding: "12px 16px",
        margin: "0 0 16px",
        border: `1px solid ${border}`,
      }}
    >
      {children}
    </Section>
  );
}

export function InfoBox({ children }: { children: ReactNode }) {
  return (
    <BoxWrapper bg="#f5f5f5" border="#eeeeee">
      {children}
    </BoxWrapper>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <BoxWrapper bg="#fef2f2" border="#fecaca">
      {children}
    </BoxWrapper>
  );
}

export function WarningBox({ children }: { children: ReactNode }) {
  return (
    <BoxWrapper bg="#fffbeb" border="#fde68a">
      {children}
    </BoxWrapper>
  );
}

export function SuccessBox({ children }: { children: ReactNode }) {
  return (
    <BoxWrapper bg="#f0fdf4" border="#bbf7d0">
      {children}
    </BoxWrapper>
  );
}

// ---------------------------------------------------------------------------
// Code block (pre-formatted text)
// ---------------------------------------------------------------------------

export function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        fontFamily: monoFamily,
        backgroundColor: "#1a1a1a",
        borderRadius: "6px",
        padding: "14px 16px",
        margin: "0 0 16px",
        fontSize: "12px",
        lineHeight: "18px",
        color: "#e0e0e0",
        whiteSpace: "pre-wrap" as const,
        overflowWrap: "break-word" as const,
      }}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Label (uppercase, small, muted -- used above boxes/sections)
// ---------------------------------------------------------------------------

export function Label({ children }: { children: ReactNode }) {
  return (
    <Text
      style={{
        color: "#888888",
        fontSize: "12px",
        lineHeight: "18px",
        margin: "0 0 4px",
        textTransform: "uppercase" as const,
        letterSpacing: "0.05em",
      }}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Re-usable inline styles for template authors
// ---------------------------------------------------------------------------

export const styles = {
  h1: {
    color: "#1a1a1a",
    fontSize: "22px",
    fontWeight: "600",
    margin: "0 0 12px",
    lineHeight: "1.3",
  } as CSSProperties,

  text: {
    color: "#333333",
    fontSize: "14px",
    lineHeight: "24px",
    margin: "0 0 16px",
  } as CSSProperties,

  muted: {
    color: "#888888",
    fontSize: "13px",
    lineHeight: "22px",
    margin: "0 0 16px",
  } as CSSProperties,

  link: {
    color: "#1a1a1a",
    fontWeight: "500",
  } as CSSProperties,

  mono: {
    fontFamily: monoFamily,
  } as CSSProperties,

  // Key-value row inside an InfoBox/ErrorBox
  kvRow: {
    color: "#333333",
    fontSize: "13px",
    lineHeight: "22px",
    margin: "0",
  } as CSSProperties,

  kvLabel: {
    color: "#888888",
    fontSize: "12px",
    display: "inline-block" as const,
    width: "110px",
  } as CSSProperties,

  kvValue: {
    color: "#1a1a1a",
    fontWeight: "500" as const,
  } as CSSProperties,

  // Inline code (SHA, branch names, commands)
  code: {
    fontFamily: monoFamily,
    backgroundColor: "#eeeeee",
    padding: "1px 6px",
    borderRadius: "3px",
    fontSize: "12px",
    color: "#333333",
  } as CSSProperties,

  // Error-tinted label/text
  errorLabel: {
    color: "#991b1b",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 4px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  } as CSSProperties,

  errorText: {
    fontFamily: monoFamily,
    color: "#991b1b",
    fontSize: "13px",
    margin: "0",
    lineHeight: "20px",
    whiteSpace: "pre-wrap" as const,
  } as CSSProperties,

  // Warning-tinted text
  warningText: {
    color: "#92400e",
    fontSize: "13px",
    lineHeight: "20px",
    margin: "0",
  } as CSSProperties,

  warningLabel: {
    color: "#92400e",
    fontSize: "12px",
    lineHeight: "18px",
    margin: "0 0 4px",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  } as CSSProperties,

  // Stage row (build pipeline)
  stageRow: {
    color: "#333333",
    fontSize: "13px",
    lineHeight: "22px",
    margin: "0",
    padding: "2px 0",
    borderBottom: "1px solid #f0f0f0",
  } as CSSProperties,

  stageDuration: {
    color: "#888888",
    fontFamily: monoFamily,
    fontSize: "12px",
    float: "right" as const,
  } as CSSProperties,

  // Badge (small inline pill)
  badge: (bg: string, color: string): CSSProperties => ({
    backgroundColor: bg,
    color,
    padding: "2px 8px",
    borderRadius: "4px",
    fontSize: "12px",
    fontWeight: "500",
    display: "inline-block",
    marginRight: "6px",
  }),
};
