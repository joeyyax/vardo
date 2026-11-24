// Credential query values, as in Traefik's RequestPath, where JSON writes & as &.
const CREDENTIAL_PARAM = /((?:[?&]|\\u0026)(?:api_key|apikey|token|access_token|password)=)[^&"\s\\#]*/gi;

/** Masks credential query values in a log line. */
export function redactLine(line: string): string {
  return line.replace(CREDENTIAL_PARAM, "$1REDACTED");
}
