import { Heading, Section, Text } from "@react-email/components";
import {
  EmailLayout,
  CTA,
  InfoBox,
  SuccessBox,
  ErrorBox,
  WarningBox,
  Label,
  styles,
} from "./components";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DigestDeploySummary = {
  total: number;
  succeeded: number;
  failed: number;
};

export type DigestBackupSummary = {
  total: number;
  succeeded: number;
  failed: number;
};

export type DigestCronSummary = {
  totalFailures: number;
  affectedJobs: string[];
};

export type DigestAlertSummary = {
  diskWriteAlerts: number;
  volumeDrifts: number;
};

export type DigestProjectRow = {
  name: string;
  deploys: number;
  failures: number;
  backupFailures: number;
  cronFailures: number;
};

export type WeeklyDigestEmailProps = {
  orgName: string;
  weekLabel: string; // e.g. "Mar 14 – Mar 20, 2026"
  deploys: DigestDeploySummary;
  backups: DigestBackupSummary;
  cron: DigestCronSummary;
  alerts: DigestAlertSummary;
  projects: DigestProjectRow[];
  dashboardUrl: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${Math.round((n / total) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export function WeeklyDigestEmail({
  orgName,
  weekLabel,
  deploys,
  backups,
  cron,
  alerts,
  projects,
  dashboardUrl,
}: WeeklyDigestEmailProps) {
  const hasAnyIssues =
    deploys.failed > 0 ||
    backups.failed > 0 ||
    cron.totalFailures > 0 ||
    alerts.diskWriteAlerts > 0 ||
    alerts.volumeDrifts > 0;

  const preview = hasAnyIssues
    ? `${orgName} weekly digest — ${deploys.failed + backups.failed + cron.totalFailures} issues need attention`
    : `${orgName} weekly digest — all systems healthy`;

  return (
    <EmailLayout preview={preview}>
      <Heading style={styles.h1}>Weekly Digest</Heading>
      <Text style={{ ...styles.muted, marginBottom: "4px" }}>{orgName}</Text>
      <Text style={{ ...styles.muted, marginTop: "0" }}>{weekLabel}</Text>

      {/* Deploy summary */}
      <Label>Deploys</Label>
      {deploys.total === 0 ? (
        <InfoBox>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>This week</span>{" "}
            <span style={styles.kvValue}>No deploys</span>
          </Text>
        </InfoBox>
      ) : deploys.failed === 0 ? (
        <SuccessBox>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Total</span>{" "}
            <span style={styles.kvValue}>{deploys.total}</span>
          </Text>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Success rate</span>{" "}
            <span style={styles.kvValue}>
              {pct(deploys.succeeded, deploys.total)} ({deploys.succeeded}/
              {deploys.total})
            </span>
          </Text>
        </SuccessBox>
      ) : (
        <ErrorBox>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Total</span>{" "}
            <span style={styles.kvValue}>{deploys.total}</span>
          </Text>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Succeeded</span>{" "}
            <span style={styles.kvValue}>{deploys.succeeded}</span>
          </Text>
          <Text style={{ ...styles.kvRow }}>
            <span style={{ ...styles.kvLabel, color: "#991b1b" }}>Failed</span>{" "}
            <span style={{ ...styles.kvValue, color: "#991b1b" }}>
              {deploys.failed}
            </span>
          </Text>
        </ErrorBox>
      )}

      {/* Backup summary */}
      <Label>Backups</Label>
      {backups.total === 0 ? (
        <InfoBox>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>This week</span>{" "}
            <span style={styles.kvValue}>No backups scheduled</span>
          </Text>
        </InfoBox>
      ) : backups.failed === 0 ? (
        <SuccessBox>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Total</span>{" "}
            <span style={styles.kvValue}>{backups.total}</span>
          </Text>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>All successful</span>{" "}
            <span style={styles.kvValue}>{backups.succeeded}</span>
          </Text>
        </SuccessBox>
      ) : (
        <ErrorBox>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Total</span>{" "}
            <span style={styles.kvValue}>{backups.total}</span>
          </Text>
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Succeeded</span>{" "}
            <span style={styles.kvValue}>{backups.succeeded}</span>
          </Text>
          <Text style={styles.kvRow}>
            <span style={{ ...styles.kvLabel, color: "#991b1b" }}>Failed</span>{" "}
            <span style={{ ...styles.kvValue, color: "#991b1b" }}>
              {backups.failed}
            </span>
          </Text>
        </ErrorBox>
      )}

      {/* Cron failures */}
      {cron.totalFailures > 0 && (
        <>
          <Label>Cron Failures</Label>
          <WarningBox>
            <Text style={styles.kvRow}>
              <span style={styles.kvLabel}>Failures</span>{" "}
              <span style={{ ...styles.kvValue, color: "#92400e" }}>
                {cron.totalFailures}
              </span>
            </Text>
            {cron.affectedJobs.length > 0 && (
              <Text style={{ ...styles.muted, margin: "4px 0 0" }}>
                Affected: {cron.affectedJobs.slice(0, 5).join(", ")}
                {cron.affectedJobs.length > 5
                  ? ` and ${cron.affectedJobs.length - 5} more`
                  : ""}
              </Text>
            )}
          </WarningBox>
        </>
      )}

      {/* Alerts */}
      {(alerts.diskWriteAlerts > 0 || alerts.volumeDrifts > 0) && (
        <>
          <Label>Alerts</Label>
          <WarningBox>
            {alerts.diskWriteAlerts > 0 && (
              <Text style={styles.kvRow}>
                <span style={styles.kvLabel}>Disk writes</span>{" "}
                <span style={{ ...styles.kvValue, color: "#92400e" }}>
                  {alerts.diskWriteAlerts} alert
                  {alerts.diskWriteAlerts !== 1 ? "s" : ""}
                </span>
              </Text>
            )}
            {alerts.volumeDrifts > 0 && (
              <Text style={styles.kvRow}>
                <span style={styles.kvLabel}>Volume drift</span>{" "}
                <span style={{ ...styles.kvValue, color: "#92400e" }}>
                  {alerts.volumeDrifts} event
                  {alerts.volumeDrifts !== 1 ? "s" : ""}
                </span>
              </Text>
            )}
          </WarningBox>
        </>
      )}

      {/* Per-project breakdown */}
      {projects.length > 0 && (
        <Section style={{ margin: "0 0 16px" }}>
          <Label>Projects</Label>
          {projects.map((p) => (
            <Text key={p.name} style={styles.stageRow}>
              <span style={{ fontWeight: p.failures > 0 ? "600" : "normal" }}>
                {p.name}
              </span>
              <span style={styles.stageDuration}>
                {p.deploys}d
                {p.failures > 0 ? ` · ${p.failures} fail` : ""}
                {p.backupFailures > 0
                  ? ` · ${p.backupFailures} bkp fail`
                  : ""}
                {p.cronFailures > 0 ? ` · ${p.cronFailures} cron fail` : ""}
              </span>
            </Text>
          ))}
        </Section>
      )}

      <CTA href={dashboardUrl}>View Dashboard &rarr;</CTA>
    </EmailLayout>
  );
}

WeeklyDigestEmail.PreviewProps = {
  orgName: "Acme Corp",
  weekLabel: "Mar 14 – Mar 20, 2026",
  deploys: { total: 12, succeeded: 10, failed: 2 },
  backups: { total: 7, succeeded: 7, failed: 0 },
  cron: { totalFailures: 3, affectedJobs: ["db-cleanup", "report-gen"] },
  alerts: { diskWriteAlerts: 1, volumeDrifts: 2 },
  projects: [
    { name: "acme-web", deploys: 6, failures: 1, backupFailures: 0, cronFailures: 0 },
    { name: "acme-api", deploys: 4, failures: 1, backupFailures: 0, cronFailures: 2 },
    { name: "acme-worker", deploys: 2, failures: 0, backupFailures: 0, cronFailures: 1 },
  ],
  dashboardUrl: "https://host.example.com",
} satisfies WeeklyDigestEmailProps;

export default WeeklyDigestEmail;
