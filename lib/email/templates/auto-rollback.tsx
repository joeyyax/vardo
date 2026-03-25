import { Heading, Text } from "@react-email/components";
import { EmailLayout, CTA, WarningBox, InfoBox, styles } from "./components";

type AutoRollbackProps = {
  appName: string;
  reason: string;
  fromDeploymentId: string;
  toDeploymentId: string;
  dashboardUrl: string;
};

export function AutoRollbackEmail({
  appName,
  reason,
  fromDeploymentId,
  toDeploymentId,
  dashboardUrl,
}: AutoRollbackProps) {
  return (
    <EmailLayout preview={`Auto-rollback triggered for ${appName}`}>
      <Heading style={styles.h1}>Auto-rollback triggered</Heading>
      <Text style={styles.text}>
        <strong>{appName}</strong> was automatically rolled back to a previous
        deployment.
      </Text>

      <WarningBox>
        <Text style={styles.warningLabel}>Reason</Text>
        <Text style={styles.warningText}>{reason}</Text>
      </WarningBox>

      <InfoBox>
        <Text style={styles.kvRow}>
          <span style={styles.kvLabel}>Rolled back from</span>{" "}
          <code style={styles.code}>{(fromDeploymentId ?? "").slice(0, 8)}</code>
        </Text>
        <Text style={styles.kvRow}>
          <span style={styles.kvLabel}>Restored to</span>{" "}
          <code style={styles.code}>{(toDeploymentId ?? "").slice(0, 8)}</code>
        </Text>
      </InfoBox>

      <Text style={styles.muted}>
        Auto-rollback activates when a newly deployed container crashes within
        the grace period. The previous healthy deployment was restored to
        minimize downtime.
      </Text>

      <CTA href={`${dashboardUrl}?tab=deployments`}>
        View deployment &rarr;
      </CTA>
    </EmailLayout>
  );
}

AutoRollbackEmail.PreviewProps = {
  appName: "acme-web",
  reason: "Container exited with code 137 (OOMKilled) within 30s of deploy",
  fromDeploymentId: "dep_abc123def456",
  toDeploymentId: "dep_789xyz012345",
  dashboardUrl: "https://host.example.com/projects/acme-web",
} satisfies AutoRollbackProps;

export default AutoRollbackEmail;
