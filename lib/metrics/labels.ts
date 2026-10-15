// The Docker labels app matching reads, and the project and organization they name.

/** Label prefixes app matching reads. Others are dropped to keep the snapshot small. */
const IDENTITY_LABEL_PREFIXES = ["vardo.", "host.", "com.docker.compose."];

export function identityLabels(labels: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (IDENTITY_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix))) out[key] = value;
  }
  return out;
}

/** Vardo project a container's labels name, or "" when none. */
export function projectOf(labels: Record<string, string> | undefined): string {
  return labels?.["vardo.project"] || labels?.["host.project"] || labels?.["com.docker.compose.project"] || "";
}

export function organizationOf(labels: Record<string, string> | undefined): string | null {
  return labels?.["vardo.organization"] || labels?.["host.organization"] || null;
}
