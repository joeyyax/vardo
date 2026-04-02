import type { VardoEnvConfig } from "./vardo-config";

export type ParsedDomain = {
  domain: string;
  port: number;
  ssl: boolean;
  isPrimary: boolean;
  redirectTo?: string;
  redirectCode?: number;
};

/**
 * Parse a vardo.yml networking block into domain records.
 *
 * The primary domain gets standard routing. Each entry in `redirects`
 * becomes a redirect domain pointing to the primary.
 */
export function parseNetworking(
  networking: NonNullable<VardoEnvConfig["networking"]>,
  containerPort: number = 3000
): ParsedDomain[] {
  const domains: ParsedDomain[] = [];

  if (!networking.domain) return domains;

  const isLocal = networking.domain.endsWith(".localhost") || networking.domain === "localhost";

  // Primary domain
  domains.push({
    domain: networking.domain,
    port: containerPort,
    ssl: networking.ssl ?? !isLocal,
    isPrimary: true,
  });

  // Redirect domains
  if (networking.redirects) {
    for (const redirectDomain of networking.redirects) {
      domains.push({
        domain: redirectDomain,
        port: containerPort,
        ssl: networking.ssl ?? !isLocal,
        isPrimary: false,
        redirectTo: `https://${networking.domain}`,
        redirectCode: 301,
      });
    }
  }

  return domains;
}
