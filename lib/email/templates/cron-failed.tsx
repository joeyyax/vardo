import { Heading, Section, Text } from "@react-email/components";
import { EmailLayout, CTA, InfoBox, CodeBlock, Label, styles } from "./components";

type CronFailedProps = {
  jobName: string;
  appName: string;
  command: string;
  errorOutput?: string;
  duration?: string;
  exitCode?: number;
  dashboardUrl: string;
};

export function CronFailedEmail({
  jobName,
  appName,
  command,
  errorOutput,
  duration,
  exitCode,
  dashboardUrl,
}: CronFailedProps) {
  const truncatedOutput =
    errorOutput && errorOutput.length > 500
      ? errorOutput.slice(-500) + "\n..."
      : errorOutput;

  return (
    <EmailLayout preview={`Cron job failed: ${jobName} on ${appName}`}>
      <Heading style={styles.h1}>Cron job failed</Heading>
      <Text style={styles.text}>
        <strong>{jobName}</strong> failed on <strong>{appName}</strong>.
      </Text>

      <InfoBox>
        <Text style={styles.kvRow}>
          <span style={styles.kvLabel}>Command</span>{" "}
          <code style={styles.code}>{command}</code>
        </Text>
        {duration && (
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Duration</span>{" "}
            <span style={styles.kvValue}>{duration}</span>
          </Text>
        )}
        {exitCode !== undefined && (
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Exit code</span>{" "}
            <span style={styles.kvValue}>{exitCode}</span>
          </Text>
        )}
      </InfoBox>

      {truncatedOutput && (
        <Section style={{ margin: "0 0 16px" }}>
          <Label>Output</Label>
          <CodeBlock>{truncatedOutput}</CodeBlock>
        </Section>
      )}

      <CTA href={`${dashboardUrl}?tab=cron`}>View cron history &rarr;</CTA>
    </EmailLayout>
  );
}

CronFailedEmail.PreviewProps = {
  jobName: "cleanup-stale-sessions",
  appName: "acme-api",
  command: "node scripts/cleanup.js --older-than 30d",
  errorOutput:
    "Error: ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect\nFailed to connect to database\nCleanup aborted",
  duration: "0.8s",
  exitCode: 1,
  dashboardUrl: "https://host.example.com/projects/acme-api",
} satisfies CronFailedProps;

export default CronFailedEmail;
