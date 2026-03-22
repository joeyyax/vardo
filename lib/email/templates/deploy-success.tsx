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

type DeploySuccessProps = {
  projectName: string;
  deploymentId: string;
  domain?: string;
  duration: string;
  gitSha?: string;
  gitMessage?: string;
  triggeredBy?: string;
  dashboardUrl: string;
};

export function DeploySuccessEmail({
  projectName,
  deploymentId,
  domain,
  duration,
  gitSha,
  gitMessage,
  triggeredBy,
  dashboardUrl,
}: DeploySuccessProps) {
  return (
    <Html>
      <Head />
      <Preview>{projectName} deployed successfully</Preview>
      <Body style={body}>
        <Container style={container}>
          <Heading style={h1}>Deploy successful</Heading>
          <Text style={text}>
            <strong>{projectName}</strong> was deployed successfully in {duration}.
          </Text>
          {gitMessage && (
            <Section style={commitBox}>
              <Text style={commitText}>
                {gitSha && <code style={sha}>{gitSha.slice(0, 7)}</code>}{" "}
                {gitMessage}
              </Text>
            </Section>
          )}
          {domain && (
            <Text style={text}>
              Live at{" "}
              <Link href={`https://${domain}`} style={link}>
                {domain}
              </Link>
            </Text>
          )}
          {triggeredBy && (
            <Text style={meta}>Deployed by {triggeredBy}</Text>
          )}
          <Hr style={hr} />
          <Text style={meta}>
            <Link href={`${dashboardUrl}?tab=deployments`} style={link}>
              View deployment →
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
const commitBox = { backgroundColor: "#27272a", borderRadius: "8px", padding: "12px 16px", margin: "12px 0" };
const commitText = { color: "#d4d4d8", fontSize: "13px", margin: "0", fontFamily: "monospace" };
const sha = { color: "#71717a", fontSize: "12px" };
