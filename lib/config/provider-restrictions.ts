/** Deployment env vars ALLOW_SMTP, ALLOW_LOCAL_BACKUPS and ALLOW_PASSWORD_AUTH restrict provider options. All default to true. */

function envBool(key: string, fallback = true): boolean {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  return val !== "false" && val !== "0";
}

/** Whether SMTP is allowed as an email provider. */
export function isSmtpAllowed(): boolean {
  return envBool("ALLOW_SMTP");
}

/** Whether local/SSH backup targets are allowed. */
export function isLocalBackupsAllowed(): boolean {
  return envBool("ALLOW_LOCAL_BACKUPS");
}

/** Whether password-based authentication is allowed. */
export function isPasswordAuthAllowed(): boolean {
  return envBool("ALLOW_PASSWORD_AUTH");
}

/** Provider restrictions, serializable for client components. */

export type ProviderRestrictions = {
  allowSmtp: boolean;
  allowLocalBackups: boolean;
  allowPasswordAuth: boolean;
};

export function getProviderRestrictions(): ProviderRestrictions {
  return {
    allowSmtp: isSmtpAllowed(),
    allowLocalBackups: isLocalBackupsAllowed(),
    allowPasswordAuth: isPasswordAuthAllowed(),
  };
}
