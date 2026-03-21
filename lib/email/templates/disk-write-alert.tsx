import { Heading, Text } from "@react-email/components";
import { EmailLayout, CTA, WarningBox, InfoBox, styles } from "./components";

type DiskWriteAlertProps = {
  appName: string;
  containerName?: string;
  writeAmount: string;
  threshold: string;
  period?: string;
  dashboardUrl: string;
};

export function DiskWriteAlertEmail({
  appName,
  containerName,
  writeAmount,
  threshold,
  period,
  dashboardUrl,
}: DiskWriteAlertProps) {
  const timePeriod = period || "the last hour";

  return (
    <EmailLayout preview={`High disk write activity on ${appName}`}>
      <Heading style={styles.h1}>High disk write activity</Heading>
      <Text style={styles.text}>
        <strong>{appName}</strong>
        {containerName && <span> ({containerName})</span>} is writing an unusual
        amount of data to disk.
      </Text>

      <WarningBox>
        <Text style={{ ...styles.warningText, fontSize: "14px" }}>
          <strong>{writeAmount}</strong> written in {timePeriod}
        </Text>
        <Text style={{ ...styles.warningText, opacity: 0.8, margin: "4px 0 0" }}>
          Threshold: {threshold}
        </Text>
      </WarningBox>

      <InfoBox>
        <Text style={styles.warningLabel}>Why this happens</Text>
        <Text
          style={{
            color: "#333333",
            fontSize: "13px",
            lineHeight: "20px",
            margin: "0",
          }}
        >
          Volumes are for persistent app state, not bulk storage. Heavy writes
          usually indicate debug logging to disk, temp file accumulation, or data
          that should be in S3/R2.
        </Text>
      </InfoBox>

      <Text style={styles.muted}>
        If this is expected (database migration, import job), you can increase the
        threshold in app settings.
      </Text>

      <CTA href={`${dashboardUrl}?tab=logs`}>Check app logs &rarr;</CTA>
    </EmailLayout>
  );
}

DiskWriteAlertEmail.PreviewProps = {
  appName: "acme-api",
  containerName: "acme-api-worker-1",
  writeAmount: "4.2 GB",
  threshold: "1 GB",
  period: "the last hour",
  dashboardUrl: "https://host.example.com/projects/acme-api",
} satisfies DiskWriteAlertProps;

export default DiskWriteAlertEmail;
