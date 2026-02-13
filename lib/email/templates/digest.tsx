import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  Text,
  Button,
} from "@react-email/components";
import * as React from "react";

interface DigestNotification {
  type: string;
  content: string;
  createdAt: string;
}

interface DigestEmailProps {
  userName: string;
  notifications: DigestNotification[];
  viewAllUrl: string;
}

const TYPE_LABELS: Record<string, string> = {
  assigned: "Assignments",
  comment: "Comments",
  status_changed: "Status Changes",
  blocker_resolved: "Blockers Resolved",
  client_comment: "Client Comments",
  mentioned: "Mentions",
  edit_requested: "Edit Requests",
};

export function DigestEmail({ userName, notifications, viewAllUrl }: DigestEmailProps) {
  const count = notifications.length;
  const previewText = `You have ${count} new notification${count === 1 ? "" : "s"}`;

  // Group by type
  const grouped = notifications.reduce<Record<string, DigestNotification[]>>((acc, n) => {
    if (!acc[n.type]) acc[n.type] = [];
    acc[n.type].push(n);
    return acc;
  }, {});

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>
            {previewText}
          </Heading>
          <Text style={subheading}>
            Hi {userName || "there"}, here&apos;s your daily summary.
          </Text>

          {Object.entries(grouped).map(([type, items]) => (
            <Section key={type} style={groupSection}>
              <Text style={groupTitle}>
                {TYPE_LABELS[type] || type} ({items.length})
              </Text>
              {items.slice(0, 5).map((item, i) => (
                <Text key={i} style={itemText}>
                  {item.content}
                </Text>
              ))}
              {items.length > 5 && (
                <Text style={moreText}>
                  ...and {items.length - 5} more
                </Text>
              )}
            </Section>
          ))}

          <Section style={buttonContainer}>
            <Button style={button} href={viewAllUrl}>
              View all notifications
            </Button>
          </Section>

          <Text style={footer}>
            You received this because you have daily digest enabled. Change this in your notification settings.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

// Styles (matching existing templates)
const main = {
  backgroundColor: "#f6f9fc",
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, sans-serif',
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

const groupSection = {
  marginBottom: "20px",
};

const groupTitle = {
  color: "#111827",
  fontSize: "16px",
  fontWeight: "600",
  margin: "0 0 8px",
  borderBottom: "1px solid #e5e7eb",
  paddingBottom: "4px",
};

const itemText = {
  color: "#374151",
  fontSize: "14px",
  lineHeight: "1.5",
  margin: "0 0 4px",
  paddingLeft: "8px",
};

const moreText = {
  color: "#9ca3af",
  fontSize: "13px",
  fontStyle: "italic" as const,
  margin: "4px 0 0",
  paddingLeft: "8px",
};

const buttonContainer = {
  textAlign: "center" as const,
  marginBottom: "32px",
  marginTop: "24px",
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

export default DigestEmail;
