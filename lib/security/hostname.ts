// A DNS hostname with no port, path or Traefik rule syntax.

export const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

export function isHostname(value: string): boolean {
  return value.length <= 253 && HOSTNAME_RE.test(value);
}
