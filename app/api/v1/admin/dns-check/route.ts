import { NextRequest, NextResponse } from "next/server";
import { resolve4 } from "dns/promises";
import { requireAdminAuth } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { getInstanceConfig } from "@/lib/system-settings";

type DnsCheck = {
  domain: string;
  resolved: boolean;
  ips: string[];
  matches: boolean;
};

export async function GET(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const config = await getInstanceConfig();
    const serverIp = config.serverIp;
    const baseDomain = config.baseDomain;
    const hostDomain = config.domain;

    const domains = [hostDomain, baseDomain].filter(Boolean);
    // Deduplicate
    const unique = [...new Set(domains)];

    const checks: DnsCheck[] = await Promise.all(
      unique.map(async (domain) => {
        try {
          const ips = await resolve4(domain);
          const matches = serverIp ? ips.includes(serverIp) : false;
          return { domain, resolved: true, ips, matches };
        } catch {
          return { domain, resolved: false, ips: [], matches: false };
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
