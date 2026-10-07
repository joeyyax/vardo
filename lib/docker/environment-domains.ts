// Which hostnames a deploy routes. Non-default environments route only their own `environment.domain`.

import type { domains } from "@/lib/db/schema";

export type DeployDomain = typeof domains.$inferSelect & { composeService?: string | null };

/** A non-default environment's own hostname, routed like the app's primary domain. */
export function environmentDomains(
  appDomains: DeployDomain[],
  env: { id: string | null; domain: string | null },
  appId: string,
): DeployDomain[] {
  if (!env.domain) return [];
  const template =
    appDomains.find((d) => d.isPrimary && !d.redirectTo) ?? appDomains.find((d) => !d.redirectTo);
  return [
    {
      id: env.id ?? env.domain,
      appId,
      domain: env.domain,
      serviceName: template?.serviceName ?? null,
      port: template?.port ?? null,
      middlewares: null,
      certResolver: template?.certResolver ?? "le-dns",
      isPrimary: true,
      sslEnabled: template?.sslEnabled ?? true,
      redirectTo: null,
      redirectCode: 301,
      createdAt: template?.createdAt ?? new Date(0),
      composeService: template?.composeService ?? null,
    },
  ];
}

/** Drop rows an older release created for a non-default environment's hostname. */
export function withoutEnvironmentHosts(
  appDomains: DeployDomain[],
  environmentHosts: Iterable<string | null>,
): DeployDomain[] {
  const hosts = new Set([...environmentHosts].filter((h): h is string => !!h));
  return hosts.size === 0 ? appDomains : appDomains.filter((d) => !hosts.has(d.domain));
}
