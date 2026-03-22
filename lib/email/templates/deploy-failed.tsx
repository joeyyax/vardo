import {
  Body,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
  Link,
} from "@react-email/components";

type DeployFailedProps = {
  projectName: string;
  deploymentId: string;
  errorMessage?: string;
  gitSha?: string;
  gitMessage?: string;
  triggeredBy?: string;
  dashboardUrl: string;
};

export function DeployFailedEmail({
  projectName,
  deploymentId,
  errorMessage,
  gitSha,
  gitMessage,
  triggeredBy,
  dashboardUrl,
}: DeployFailedProps) {
  return (
    <Html>
      <Head />
      <Preview>{projectName} deployment failed</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Deploy failed</Heading>
          <Text style={text}>
            <strong>{projectName}</strong> failed to deploy.
          </Text>
          {errorMessage && (
            <Section style={errorBox}>
              <Text style={errorText}>{errorMessage}</Text>
            </Section>
          )}
          {gitMessage && (
            <Text style={meta}>
              {gitSha && <code style={sha}>{gitSha.slice(0, 7)}</code>}{" "}
              {gitMessage}
            </Text>
          )}
          {triggeredBy && (
            <Text style={meta}>Triggered by {triggeredBy}</Text>
          )}
          <Hr style={hr} />
          <Text style={meta}>
            <Link href={`${dashboardUrl}?tab=deployments`} style={link}>
              View logs →
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

const body = { backgroundColor: "#18181b", fontFamily: "system-ui, sans-serif" };
const container = { maxWidth: "480px", margin: "40px auto", padding: "24px" };
const h1 = { color: "#fafafa", fontSize: "20px", fontWeight: "600" as const, margin: "0 0 16px" };
const text = { color: "#a1a1aa", fontSize: "14px", lineHeight: "24px" };
const meta = { color: "#71717a", fontSize: "12px", lineHeight: "20px" };
const link = { color: "#d4a574" };
const hr = { borderColor: "#27272a", margin: "24px 0" };
const errorBox = { backgroundColor: "#2d1215", borderRadius: "8px", padding: "12px 16px", margin: "12px 0", borderLeft: "3px solid #7f1d1d" };
const errorText = { color: "#fca5a5", fontSize: "13px", margin: "0", fontFamily: "monospace", whiteSpace: "pre-wrap" as const };
const sha = { color: "#71717a", fontSize: "12px" };
