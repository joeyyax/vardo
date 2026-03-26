import { NextRequest, NextResponse } from "next/server";
import { resolve4 } from "dns/promises";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { getInstanceConfig } from "@/lib/system-settings";
import { getServerIP } from "@/lib/server-ip";
import { isCloudflareIp } from "@/lib/cloudflare-ips";

type DnsCheck = {
  domain: string;
  resolved: boolean;
  ips: string[];
  matches: boolean;
  proxied: boolean;
  reachable: boolean;
  proxyProvider: "cloudflare" | null;
};

export async function GET(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const config = await getInstanceConfig();
    const serverIp = config.serverIp || (await getServerIP());
    const baseDomain = config.baseDomain;
    const hostDomain = config.domain;

    const domains = [hostDomain, baseDomain].filter(Boolean);
    const unique = [...new Set(domains)];

    const checks: DnsCheck[] = await Promise.all(
      unique.map(async (domain) => {
        try {
          const ips = await resolve4(domain);
          const directMatch = serverIp ? ips.includes(serverIp) : false;
          const allCloudflare = ips.length > 0 && ips.every(isCloudflareIp);

          let reachable = false;
          if (!directMatch && ips.length > 0) {
            // Check HTTP reachability when IPs don't directly match
            try {
              await fetch(`https://${domain}`, {
                method: "HEAD",
                signal: AbortSignal.timeout(5000),
                redirect: "manual",
              });
              reachable = true;
            } catch {
              // Domain didn't respond
            }
          }

          return {
            domain,
            resolved: true,
            ips,
            matches: directMatch || (allCloudflare && reachable),
            proxied: allCloudflare,
            reachable: directMatch || reachable,
            proxyProvider: allCloudflare ? "cloudflare" as const : null,
          };
        } catch {
          return {
            domain,
            resolved: false,
            ips: [],
            matches: false,
            proxied: false,
            reachable: false,
            proxyProvider: null,
          };
        }
      }),
    );

    return NextResponse.json({ checks, serverIp });
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (error instanceof Error && error.message === "Forbidden") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return handleRouteError(error, "Error checking DNS");
  }
}
