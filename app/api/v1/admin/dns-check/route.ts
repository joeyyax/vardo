import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { resolve4 } from "dns/promises";
import { requireAdminAuth } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { getInstanceConfig } from "@/lib/system-settings";
import { getServerIP } from "@/lib/server-ip";
import { isHostname } from "@/lib/security/hostname";
import { probeReach, reachVerdict, type ProxyProvider } from "@/lib/domains/reach";

type DnsCheck = {
  domain: string;
  resolved: boolean;
  ips: string[];
  matches: boolean;
  verified: boolean;
  proxied: boolean;
  reachable: boolean;
  proxyProvider: ProxyProvider | null;
  /** The reach check itself failed. */
  failed?: boolean;
};

async function handleGet(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const config = await getInstanceConfig();
    const serverIp = config.serverIp || (await getServerIP());
    const baseDomain = config.baseDomain;
    const hostDomain = config.domain;

    const domains = [hostDomain, baseDomain].filter(Boolean);
    const unique = [...new Set(domains)];

    const checks: DnsCheck[] = await Promise.all(
      unique.map(async (domain): Promise<DnsCheck> => {
        let ips: string[];
        try {
          ips = await resolve4(domain);
        } catch {
          return { domain, resolved: false, ips: [], matches: false, verified: false, proxied: false, reachable: false, proxyProvider: null };
        }
        const directMatch = serverIp ? ips.includes(serverIp) : false;
        try {
          const reach = isHostname(domain) ? await probeReach(domain) : { outcome: "no-response" as const, proxy: null };
          const verdict = reachVerdict(reach, directMatch);
          return {
            domain,
            resolved: true,
            ips,
            matches: verdict.configured,
            verified: verdict.verified,
            proxied: reach.proxy !== null,
            reachable: verdict.reachable,
            proxyProvider: reach.proxy,
          };
        } catch {
          return { domain, resolved: true, ips, matches: false, verified: false, proxied: false, reachable: false, proxyProvider: null, failed: true };
        }
      }),
    );

    return NextResponse.json({ checks, serverIp });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return apiError.unauthorized();
    }
    return handleRouteError(error, "Error checking DNS");
  }
}

export const GET = withRateLimit(handleGet, { tier: "heavy", key: "get:v1/admin/dns-check" });
