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

interface TaskAssignmentEmailProps {
  actorName: string;
  taskName: string;
  projectName: string;
  taskUrl: string;
}

export function TaskAssignmentEmail({
  actorName,
  taskName,
  projectName,
  taskUrl,
}: TaskAssignmentEmailProps) {
  const previewText = `${actorName} assigned you to "${taskName}"`;

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Heading style={heading}>Task assigned to you</Heading>
          <Text style={subheading}>
            {actorName} assigned you to a task
          </Text>

          <Section style={taskBox}>
            <Text style={taskTitle}>{taskName}</Text>
            <Text style={projectLabel}>Project: {projectName}</Text>
          </Section>

          <Section style={buttonContainer}>
            <Button style={button} href={taskUrl}>
              View Task
            </Button>
          </Section>

          <Text style={footer}>
            You received this email because you were assigned to a task.
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

const subheading = {
  color: "#6b7280",
  fontSize: "16px",
  lineHeight: "1.5",
  margin: "0 0 24px",
};

const taskBox = {
  backgroundColor: "#f9fafb",
  borderRadius: "8px",
  padding: "24px",
  marginBottom: "24px",
};

const taskTitle = {
  color: "#111827",
  fontSize: "18px",
  fontWeight: "600",
  margin: "0 0 8px",
};

const projectLabel = {
  color: "#6b7280",
  fontSize: "14px",
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

export default TaskAssignmentEmail;
