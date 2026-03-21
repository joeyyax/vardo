import { Heading, Section, Text } from "@react-email/components";
import { EmailLayout, CTA, WarningBox, CodeBlock, Label, styles } from "./components";

type VolumeDriftProps = {
  appName: string;
  volumeName: string;
  modifiedCount: number;
  addedCount: number;
  missingCount: number;
  changedFiles?: string[];
  dashboardUrl: string;
};

export function VolumeDriftEmail({
  appName,
  volumeName,
  modifiedCount,
  addedCount,
  missingCount,
  changedFiles,
  dashboardUrl,
}: VolumeDriftProps) {
  const totalChanges = modifiedCount + addedCount + missingCount;
  const topFiles = changedFiles?.slice(0, 5);

  return (
    <EmailLayout
      preview={`Volume drift detected on ${appName}/${volumeName}`}
    >
      <Heading style={styles.h1}>Volume drift detected</Heading>
      <Text style={styles.text}>
        <strong>{appName}</strong> has {totalChanges} unexpected{" "}
        {totalChanges === 1 ? "change" : "changes"} on volume{" "}
        <strong>{volumeName}</strong>.
      </Text>

      <WarningBox>
        <Text
          style={{
            color: "#333333",
            fontSize: "13px",
            lineHeight: "22px",
            margin: "0",
          }}
        >
          {modifiedCount > 0 && (
            <span style={styles.badge("#fef3c7", "#92400e")}>
              {modifiedCount} modified
            </span>
          )}
          {addedCount > 0 && (
            <span style={styles.badge("#d1fae5", "#065f46")}>
              {addedCount} added
            </span>
          )}
          {missingCount > 0 && (
            <span style={styles.badge("#fee2e2", "#991b1b")}>
              {missingCount} missing
            </span>
          )}
        </Text>
      </WarningBox>

      {topFiles && topFiles.length > 0 && (
        <Section style={{ margin: "0 0 16px" }}>
          <Label>Changed files</Label>
          <CodeBlock>
            {topFiles.join("\n")}
            {changedFiles && changedFiles.length > 5 &&
              `\n... and ${changedFiles.length - 5} more`}
          </CodeBlock>
        </Section>
      )}

      <Text style={styles.muted}>
        Volume drift means files on disk have diverged from what was expected.
        This can happen when a container modifies files outside of normal
        operation, or after an interrupted restore.
      </Text>

      <CTA href={`${dashboardUrl}?tab=volumes`}>Review changes &rarr;</CTA>
    </EmailLayout>
  );
}

VolumeDriftEmail.PreviewProps = {
  appName: "acme-cms",
  volumeName: "uploads",
  modifiedCount: 3,
  addedCount: 12,
  missingCount: 1,
  changedFiles: [
    "uploads/2026/03/hero.webp",
    "uploads/2026/03/thumb-001.jpg",
    "uploads/cache/resize-512x512.tmp",
    "uploads/.gitkeep",
    "config/settings.json",
    "logs/access.log",
    "logs/error.log",
  ],
  dashboardUrl: "https://host.example.com/projects/acme-cms",
} satisfies VolumeDriftProps;

export default VolumeDriftEmail;
