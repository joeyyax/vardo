/** Stands in for a secret org env value. A save that sends it back keeps the stored value. */
export const SECRET_MASK = "••••••••";

type OrgEnvVar = { key: string; value: string; isSecret: boolean | null };

/** Render org env vars as `.env` content, secrets masked. */
export function orgEnvToContent(vars: OrgEnvVar[]): string {
  return vars.map((v) => `${v.key}=${v.isSecret ? SECRET_MASK : v.value}`).join("\n");
}
