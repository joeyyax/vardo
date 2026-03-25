import { Heading, Link, Section, Text } from "@react-email/components";
import { EmailLayout, CTA, InfoBox, Label, styles } from "./components";

type BuildStage = {
  name: string;
  duration?: string;
  status: "success" | "skipped";
};

type DeploySuccessProps = {
  projectName: string;
  deploymentId: string;
  domain?: string;
  duration: string;
  gitSha?: string;
  gitMessage?: string;
  gitAuthor?: string;
  gitBranch?: string;
  triggeredBy?: string;
  triggerReason?: string;
  imageName?: string;
  imageTag?: string;
  buildStages?: BuildStage[];
  dashboardUrl: string;
};

export function DeploySuccessEmail({
  projectName,
  deploymentId,
  domain,
  duration,
  gitSha,
  gitMessage,
  gitAuthor,
  gitBranch,
  triggeredBy,
  triggerReason,
  imageName,
  imageTag,
  buildStages,
  dashboardUrl,
}: DeploySuccessProps) {
  const trigger =
    triggerReason || (triggeredBy ? `Manual deploy by ${triggeredBy}` : null);

  return (
    <EmailLayout preview={`${projectName} deployed successfully`}>
      <Heading style={styles.h1}>Deploy successful</Heading>
      <Text style={styles.text}>
        <strong>{projectName}</strong> was deployed successfully.
      </Text>

      <InfoBox>
        <Text style={styles.kvRow}>
          <span style={styles.kvLabel}>Duration</span>{" "}
          <span style={styles.kvValue}>{duration}</span>
        </Text>
        {trigger && (
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Trigger</span>{" "}
            <span style={styles.kvValue}>{trigger}</span>
          </Text>
        )}
        {domain && (
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Live at</span>{" "}
            <Link href={`https://${domain}`} style={styles.link}>
              {domain}
            </Link>
          </Text>
        )}
      </InfoBox>

      {(gitSha || gitMessage) && (
        <InfoBox>
          <Label>Commit</Label>
          <Text
            style={{
              ...styles.mono,
              color: "#333333",
              fontSize: "13px",
              margin: "0",
              lineHeight: "20px",
            }}
          >
            {gitSha && <code style={styles.code}>{gitSha.slice(0, 7)}</code>}{" "}
            {gitMessage}
          </Text>
          {(gitAuthor || gitBranch) && (
            <Text
              style={{
                color: "#888888",
                fontSize: "12px",
                lineHeight: "22px",
                margin: "4px 0 0",
              }}
            >
              {gitAuthor && <span>{gitAuthor}</span>}
              {gitAuthor && gitBranch && <span> on </span>}
              {gitBranch && <code style={styles.code}>{gitBranch}</code>}
            </Text>
          )}
        </InfoBox>
      )}

      {imageName && (
        <InfoBox>
          <Label>Image</Label>
          <Text
            style={{
              ...styles.mono,
              color: "#333333",
              fontSize: "13px",
              margin: "0",
              lineHeight: "20px",
            }}
          >
            {imageName}
            {imageTag && (
              <span style={{ color: "#888888", fontSize: "12px" }}>
                :{imageTag}
              </span>
            )}
          </Text>
        </InfoBox>
      )}

      {buildStages && buildStages.length > 0 && (
        <Section style={{ margin: "0 0 16px" }}>
          <Label>Build stages</Label>
          {buildStages.map((stage, i) => (
            <Text key={i} style={styles.stageRow}>
              <span>
                {stage.status === "success" ? "\u2713" : "\u2014"} {stage.name}
              </span>
              {stage.duration && (
                <span style={styles.stageDuration}>{stage.duration}</span>
              )}
            </Text>
          ))}
        </Section>
      )}

      <CTA href={`${dashboardUrl}?tab=deployments`}>
        View deployment &rarr;
      </CTA>
    </EmailLayout>
  );
}

DeploySuccessEmail.PreviewProps = {
  projectName: "acme-web",
  deploymentId: "dep_abc123def456",
  domain: "acme.example.com",
  duration: "1m 42s",
  gitSha: "a1b2c3d4e5f6a7b8c9d0",
  gitMessage: "fix: resolve auth redirect loop on logout",
  gitAuthor: "Joey Yax",
  gitBranch: "main",
  triggerReason: "Push to main",
  buildStages: [
    { name: "Clone repository", duration: "3s", status: "success" as const },
    { name: "Build image", duration: "1m 12s", status: "success" as const },
    { name: "Deploy container", duration: "18s", status: "success" as const },
    { name: "Health check", duration: "9s", status: "success" as const },
  ],
  dashboardUrl: "https://host.example.com/projects/acme-web",
} satisfies DeploySuccessProps;

export default DeploySuccessEmail;
