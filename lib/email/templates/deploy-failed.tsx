import { Heading, Section, Text } from "@react-email/components";
import {
  EmailLayout,
  CTA,
  ErrorBox,
  InfoBox,
  CodeBlock,
  Label,
  styles,
} from "./components";

type DeployFailedProps = {
  projectName: string;
  deploymentId: string;
  errorMessage?: string;
  errorSnapshot?: string;
  failedAtStage?: string;
  gitSha?: string;
  gitMessage?: string;
  gitAuthor?: string;
  gitBranch?: string;
  triggeredBy?: string;
  triggerReason?: string;
  dashboardUrl: string;
};

export function DeployFailedEmail({
  projectName,
  deploymentId,
  errorMessage,
  errorSnapshot,
  failedAtStage,
  gitSha,
  gitMessage,
  gitAuthor,
  gitBranch,
  triggeredBy,
  triggerReason,
  dashboardUrl,
}: DeployFailedProps) {
  const trigger =
    triggerReason || (triggeredBy ? `Manual deploy by ${triggeredBy}` : null);

  return (
    <EmailLayout preview={`${projectName} deployment failed`}>
      <Heading style={styles.h1}>Deploy failed</Heading>
      <Text style={styles.text}>
        <strong>{projectName}</strong> failed to deploy.
      </Text>

      {(failedAtStage || trigger) && (
        <ErrorBox>
          {failedAtStage && (
            <Text style={styles.kvRow}>
              <span style={{ ...styles.kvLabel, color: "#991b1b" }}>
                Failed at
              </span>{" "}
              <span style={styles.kvValue}>{failedAtStage}</span>
            </Text>
          )}
          {trigger && (
            <Text style={styles.kvRow}>
              <span style={{ ...styles.kvLabel, color: "#991b1b" }}>
                Trigger
              </span>{" "}
              <span style={styles.kvValue}>{trigger}</span>
            </Text>
          )}
        </ErrorBox>
      )}

      {errorMessage && (
        <ErrorBox>
          <Text style={styles.errorLabel}>Error</Text>
          <Text style={styles.errorText}>{errorMessage}</Text>
        </ErrorBox>
      )}

      {errorSnapshot && (
        <Section style={{ margin: "0 0 16px" }}>
          <Label>Build log (last lines)</Label>
          <CodeBlock>{errorSnapshot}</CodeBlock>
        </Section>
      )}

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

      <CTA href={`${dashboardUrl}?tab=deployments`}>View logs &rarr;</CTA>
    </EmailLayout>
  );
}

DeployFailedEmail.PreviewProps = {
  projectName: "acme-web",
  deploymentId: "dep_abc123def456",
  failedAtStage: "docker build",
  errorMessage: "COPY failed: file not found in build context",
  errorSnapshot:
    "Step 8/12 : COPY package.json ./\n ---> Using cache\nStep 9/12 : RUN npm ci\n ---> Running in 3a2b1c0d\nStep 10/12 : COPY . .\nCOPY failed: file not found in build context or excluded by .dockerignore: stat src/config.ts: file does not exist",
  gitSha: "f9e8d7c6b5a4f3e2d1c0",
  gitMessage: "chore: update dependencies",
  gitAuthor: "Joey Yax",
  gitBranch: "main",
  triggerReason: "Push to main",
  dashboardUrl: "https://host.example.com/projects/acme-web",
} satisfies DeployFailedProps;

export default DeployFailedEmail;
