import { Heading, Text } from "@react-email/components";
import { EmailLayout, CTA, ErrorBox, styles } from "./components";

type BackupFailedProps = {
  appName: string;
  volumeName?: string;
  errorMessage: string;
  dashboardUrl: string;
};

export function BackupFailedEmail({
  appName,
  volumeName,
  errorMessage,
  dashboardUrl,
}: BackupFailedProps) {
  return (
    <EmailLayout preview={`Backup failed for ${appName}`}>
      <Heading style={styles.h1}>Backup failed</Heading>
      <Text style={styles.text}>
        A backup for <strong>{appName}</strong> failed
        {volumeName && (
          <span>
            {" "}
            on volume <strong>{volumeName}</strong>
          </span>
        )}
        .
      </Text>

      <ErrorBox>
        <Text style={styles.errorLabel}>Error</Text>
        <Text style={styles.errorText}>{errorMessage}</Text>
      </ErrorBox>

      <CTA href={`${dashboardUrl}?tab=backups`}>View logs &rarr;</CTA>
    </EmailLayout>
  );
}

BackupFailedEmail.PreviewProps = {
  appName: "acme-db",
  volumeName: "postgres_data",
  errorMessage: "tar: /var/lib/postgresql/data: Cannot open: Permission denied",
  dashboardUrl: "https://host.example.com/projects/acme-db",
} satisfies BackupFailedProps;

export default BackupFailedEmail;
