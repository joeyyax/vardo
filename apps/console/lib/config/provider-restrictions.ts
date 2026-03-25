/**
 * Provider restrictions — deployment-level env vars that control
 * which provider options are available on an instance.
 *
 * These are set at deployment time, not runtime. Used by Vardo Cloud
 * to restrict unreliable or insecure options.
 *
 * | Env var              | Default | What it controls                    |
 * |----------------------|---------|-------------------------------------|
 * | ALLOW_SMTP           | true    | SMTP as an email provider option    |
 * | ALLOW_LOCAL_BACKUPS   | true    | Local/SSH backup targets            |
 * | ALLOW_PASSWORD_AUTH  | true    | Password-based authentication       |
 *
 * Self-hosted: all default to true — full control, no restrictions.
 * Vardo Cloud: set in the deployment environment, users never see them.
 */

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

/**
 * All provider restrictions as a serializable object.
 * Pass from server components to client components.
 */
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
