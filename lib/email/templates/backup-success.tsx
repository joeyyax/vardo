import { Heading, Text } from "@react-email/components";
import { EmailLayout, CTA, SuccessBox, styles } from "./components";

type BackupSuccessProps = {
  appName: string;
  volumeNames: string[];
  totalSize: string;
  duration: string;
  storageBucket?: string;
  storageTarget?: string;
  dashboardUrl: string;
};

export function BackupSuccessEmail({
  appName,
  volumeNames,
  totalSize,
  duration,
  storageBucket,
  storageTarget,
  dashboardUrl,
}: BackupSuccessProps) {
  return (
    <EmailLayout preview={`Backup complete for ${appName}`}>
      <Heading style={styles.h1}>Backup complete</Heading>
      <Text style={styles.text}>
        <strong>{appName}</strong> was backed up successfully.
      </Text>

      <SuccessBox>
        <Text style={styles.kvRow}>
          <span style={styles.kvLabel}>Volumes</span>{" "}
          <span style={styles.kvValue}>{(volumeNames ?? []).join(", ")}</span>
        </Text>
        <Text style={styles.kvRow}>
          <span style={styles.kvLabel}>Total size</span>{" "}
          <span style={styles.kvValue}>{totalSize}</span>
        </Text>
        <Text style={styles.kvRow}>
          <span style={styles.kvLabel}>Duration</span>{" "}
          <span style={styles.kvValue}>{duration}</span>
        </Text>
        {(storageBucket || storageTarget) && (
          <Text style={styles.kvRow}>
            <span style={styles.kvLabel}>Storage</span>{" "}
            <span style={styles.kvValue}>
              {storageBucket || storageTarget}
            </span>
          </Text>
        )}
      </SuccessBox>

      <CTA href={`${dashboardUrl}?tab=backups`}>View backups &rarr;</CTA>
    </EmailLayout>
  );
}

BackupSuccessEmail.PreviewProps = {
  appName: "acme-db",
  volumeNames: ["postgres_data", "redis_data"],
  totalSize: "2.4 GB",
  duration: "3m 12s",
  storageBucket: "s3://backups/acme-db",
  dashboardUrl: "https://host.example.com/projects/acme-db",
} satisfies BackupSuccessProps;

export default BackupSuccessEmail;
