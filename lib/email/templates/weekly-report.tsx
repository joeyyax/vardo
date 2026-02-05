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

interface ProjectBreakdown {
  name: string;
  minutes: number;
  percentage: number;
}

interface WeeklyReportEmailProps {
  organizationName: string;
  reportTitle: string; // Client or project name
  periodStart: string;
  periodEnd: string;
  totalMinutes: number;
  totalBillable?: number; // cents
  entryCount: number;
  projectBreakdown: ProjectBreakdown[];
  reportUrl: string;
  showRates: boolean;
}

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function WeeklyReportEmail({
  organizationName,
  reportTitle,
  periodStart,
  periodEnd,
  totalMinutes,
  totalBillable,
  entryCount,
  projectBreakdown,
  reportUrl,
  showRates,
}: WeeklyReportEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        Weekly time report: {formatHours(totalMinutes)} logged for {reportTitle}
      </Preview>
      <Body style={main}>
        <Container style={container}>
          {/* Header */}
          <Section style={header}>
            <Text style={headerText}>{organizationName}</Text>
          </Section>

          {/* Title */}
          <Heading style={h1}>Weekly Time Report</Heading>
          <Text style={subtitle}>{reportTitle}</Text>
          <Text style={dateRange}>
            {formatDate(periodStart)} – {formatDate(periodEnd)}
          </Text>

          <Hr style={hr} />

          {/* Summary Stats */}
          <Section style={statsSection}>
            <Row>
              <Column style={statColumn}>
                <Text style={statLabel}>Total Time</Text>
                <Text style={statValue}>{formatHours(totalMinutes)}</Text>
              </Column>
              <Column style={statColumn}>
                <Text style={statLabel}>Entries</Text>
                <Text style={statValue}>{entryCount}</Text>
              </Column>
              {showRates && totalBillable !== undefined && (
                <Column style={statColumn}>
                  <Text style={statLabel}>Billable</Text>
                  <Text style={statValue}>{formatCurrency(totalBillable)}</Text>
                </Column>
              )}
            </Row>
          </Section>

          <Hr style={hr} />

          {/* Project Breakdown */}
          {projectBreakdown.length > 0 && (
            <Section style={breakdownSection}>
              <Text style={sectionTitle}>Hours by Project</Text>
              {projectBreakdown.map((project, index) => (
                <Row key={index} style={projectRow}>
                  <Column style={projectNameColumn}>
                    <Text style={projectName}>{project.name}</Text>
                  </Column>
                  <Column style={projectStatsColumn}>
                    <Text style={projectHours}>{formatHours(project.minutes)}</Text>
                    <Text style={projectPercentage}>{project.percentage}%</Text>
                  </Column>
                </Row>
              ))}
            </Section>
          )}

          <Hr style={hr} />

          {/* CTA */}
          <Section style={ctaSection}>
            <Button style={button} href={reportUrl}>
              View Full Report
            </Button>
          </Section>

          {/* Footer */}
          <Section style={footer}>
            <Text style={footerText}>
              This is an automated weekly report from {organizationName}.
            </Text>
            <Text style={footerText}>
              You&apos;re receiving this because you&apos;re on the recipient list for this report.
            </Text>
          </Section>
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
  fontSize: "28px",
  fontWeight: "700",
  color: "#111827",
  margin: "0 0 8px 0",
};

const subtitle = {
  fontSize: "18px",
  color: "#374151",
  margin: "0 0 4px 0",
};

const dateRange = {
  fontSize: "14px",
  color: "#6b7280",
  margin: "0",
};

const hr = {
  borderColor: "#e5e7eb",
  margin: "24px 0",
};

const statsSection = {
  padding: "16px 0",
};

const statColumn = {
  textAlign: "center" as const,
};

const statLabel = {
  fontSize: "12px",
  fontWeight: "500",
  color: "#6b7280",
  textTransform: "uppercase" as const,
  letterSpacing: "0.5px",
  margin: "0 0 4px 0",
};

const statValue = {
  fontSize: "24px",
  fontWeight: "700",
  color: "#111827",
  margin: "0",
};

const breakdownSection = {
  padding: "8px 0",
};

const sectionTitle = {
  fontSize: "14px",
  fontWeight: "600",
  color: "#374151",
  margin: "0 0 16px 0",
};

const projectRow = {
  marginBottom: "12px",
};

const projectNameColumn = {
  width: "60%",
};

const projectStatsColumn = {
  width: "40%",
  textAlign: "right" as const,
};

const projectName = {
  fontSize: "14px",
  color: "#374151",
  margin: "0",
};

const projectHours = {
  fontSize: "14px",
  fontWeight: "600",
  color: "#111827",
  margin: "0",
  display: "inline",
};

const projectPercentage = {
  fontSize: "12px",
  color: "#6b7280",
  margin: "0 0 0 8px",
  display: "inline",
};

const ctaSection = {
  textAlign: "center" as const,
  padding: "16px 0",
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

const footer = {
  marginTop: "32px",
};

const footerText = {
  fontSize: "12px",
  color: "#9ca3af",
  margin: "0 0 4px 0",
  textAlign: "center" as const,
};

export default WeeklyReportEmail;
