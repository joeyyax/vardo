import { Heading, Text } from "@react-email/components";
import {
  EmailLayout,
  CTA,
  ErrorBox,
  WarningBox,
  InfoBox,
  styles,
} from "./components";

type SystemAlertType =
  | "system.service-down"
  | "system.disk-alert"
  | "system.restart-loop"
  | "system.cert-expiring"
  | "system.update-available";

type SystemAlertProps = {
  alertType: SystemAlertType;
  title: string;
  message: string;
  details?: Record<string, string>;
  dashboardUrl?: string;
};

function isCritical(
  alertType: SystemAlertType,
  details?: Record<string, string>,
): boolean {
  if (alertType === "system.service-down") return true;
  if (alertType === "system.disk-alert") {
    const threshold = parseInt(details?.threshold ?? "0");
    return threshold >= 95;
  }
  return false;
}

export function SystemAlertEmail({
  alertType,
  title,
  message,
  details,
  dashboardUrl,
}: SystemAlertProps) {
  const critical = isCritical(alertType, details);
  const appUrl =
    dashboardUrl ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000";
  const healthUrl = `${appUrl}/admin`;

  return (
    <EmailLayout preview={title}>
      <Heading style={styles.h1}>{title}</Heading>
      <Text style={styles.text}>{message}</Text>

      {critical ? (
        <ErrorBox>
          {details &&
            Object.entries(details).map(([k, v]) =>
              v ? (
                <Text key={k} style={styles.kvRow}>
                  <span style={styles.kvLabel}>{k}</span>
                  <span style={styles.kvValue}>{v}</span>
                </Text>
              ) : null,
            )}
        </ErrorBox>
      ) : (
        <WarningBox>
          {details &&
            Object.entries(details).map(([k, v]) =>
              v ? (
                <Text key={k} style={styles.kvRow}>
                  <span style={styles.kvLabel}>{k}</span>
                  <span style={styles.kvValue}>{v}</span>
                </Text>
              ) : null,
            )}
        </WarningBox>
      )}

      {alertType === "system.update-available" && (
        <InfoBox>
          <Text style={styles.muted}>
            Pull the latest changes and redeploy Vardo at your convenience. No
            immediate action required.
          </Text>
        </InfoBox>
      )}

      <CTA href={healthUrl}>View system health &rarr;</CTA>
    </EmailLayout>
  );
}

SystemAlertEmail.PreviewProps = {
  alertType: "system.service-down" as const,
  title: "Service degraded: PostgreSQL",
  message:
    "PostgreSQL (Primary database) is no longer responding. Check system health for details.",
  details: {
    service: "PostgreSQL",
    description: "Primary database",
    latencyMs: "2001",
  },
  dashboardUrl: "https://host.example.com",
} satisfies SystemAlertProps;

export default SystemAlertEmail;
