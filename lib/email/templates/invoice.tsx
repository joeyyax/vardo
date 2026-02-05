import {
  Body,
  Button,
  Container,
  Column,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Row,
  Section,
  Text,
} from "@react-email/components";
import * as React from "react";

interface InvoiceEmailProps {
  invoiceNumber: string;
  organizationName: string;
  clientName: string;
  periodStart: string;
  periodEnd: string;
  totalMinutes: number;
  subtotal: number; // cents
  publicUrl: string;
  message?: string;
}

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function InvoiceEmail({
  invoiceNumber,
  organizationName,
  clientName,
  periodStart,
  periodEnd,
  totalMinutes,
  subtotal,
  publicUrl,
  message,
}: InvoiceEmailProps) {
  const previewText = `Invoice ${invoiceNumber} from ${organizationName} - ${formatCurrency(subtotal)}`;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>Invoice {invoiceNumber}</Heading>
          <Text style={subheading}>From {organizationName}</Text>

          {message && <Text style={messageStyle}>{message}</Text>}

          <Section style={summaryBox}>
            <Row>
              <Column style={labelColumn}>
                <Text style={label}>Client</Text>
              </Column>
              <Column style={valueColumn}>
                <Text style={valueBold}>{clientName}</Text>
              </Column>
            </Row>
            <Row>
              <Column style={labelColumn}>
                <Text style={label}>Period</Text>
              </Column>
              <Column style={valueColumn}>
                <Text style={value}>
                  {formatDate(periodStart)} to {formatDate(periodEnd)}
                </Text>
              </Column>
            </Row>
            <Row>
              <Column style={labelColumn}>
                <Text style={label}>Total Hours</Text>
              </Column>
              <Column style={valueColumn}>
                <Text style={value}>{formatHours(totalMinutes)}</Text>
              </Column>
            </Row>
            <Hr style={divider} />
            <Row>
              <Column style={labelColumn}>
                <Text style={totalLabel}>Total</Text>
              </Column>
              <Column style={valueColumn}>
                <Text style={totalValue}>{formatCurrency(subtotal)}</Text>
              </Column>
            </Row>
          </Section>

          <Section style={buttonContainer}>
            <Button style={button} href={publicUrl}>
              View Invoice
            </Button>
          </Section>

          <Text style={footer}>A PDF copy of this invoice is attached.</Text>
        </Container>
      </Body>
    </Html>
  );
}

// Styles
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

const subheading = {
  color: "#6b7280",
  fontSize: "16px",
  lineHeight: "1.5",
  margin: "0 0 24px",
};

const messageStyle = {
  color: "#374151",
  fontSize: "14px",
  lineHeight: "1.6",
  margin: "0 0 24px",
  whiteSpace: "pre-wrap" as const,
};

const summaryBox = {
  backgroundColor: "#f9fafb",
  borderRadius: "8px",
  padding: "24px",
  marginBottom: "24px",
};

const labelColumn = {
  width: "50%",
};

const valueColumn = {
  width: "50%",
  textAlign: "right" as const,
};

const label = {
  color: "#6b7280",
  fontSize: "14px",
  margin: "4px 0",
};

const value = {
  color: "#111827",
  fontSize: "14px",
  margin: "4px 0",
};

const valueBold = {
  color: "#111827",
  fontSize: "14px",
  fontWeight: "600",
  margin: "4px 0",
};

const divider = {
  borderColor: "#e5e7eb",
  margin: "16px 0",
};

const totalLabel = {
  color: "#111827",
  fontSize: "18px",
  fontWeight: "600",
  margin: "4px 0",
};

const totalValue = {
  color: "#111827",
  fontSize: "18px",
  fontWeight: "600",
  margin: "4px 0",
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

export default InvoiceEmail;
