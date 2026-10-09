// The slot `.env` that docker compose reads. Compose decodes `\\`, `\"`, `\n` and `\r` inside double quotes,
// so a value with a newline stays on one line.

/** `.env` content for compose from resolved env vars. */
export function composeEnvFile(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => {
      if (/[\n\r"' $#\\]/.test(v)) {
        return `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
      }
      return `${k}=${v}`;
    })
    .join("\n");
}
