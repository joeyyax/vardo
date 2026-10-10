import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { resolve4, resolveCname } from "dns/promises";
import { getServerIP } from "@/lib/server-ip";
import { apiError } from "@/lib/api/error-response";
import { isHostname } from "@/lib/security/hostname";
import { probeReach, reachVerdict } from "@/lib/domains/reach";
import { getInstanceBaseDomain } from "@/lib/domain-monitoring/base-domain";

// GET /api/v1/dns-check?domain=example.com&expected=auto-generated.localhost
async function handleGet(request: NextRequest) {
  const { getSession } = await import("@/lib/auth/session");
  const session = await getSession();
  if (!session?.user?.id) {
    return apiError.unauthorized();
  }

  const domain = request.nextUrl.searchParams.get("domain");
  const expected = request.nextUrl.searchParams.get("expected");

  if (!domain) {
    return NextResponse.json({ error: "domain required" }, { status: 400 });
  }
  // A path or port here turned the .localhost probe into a request to any internal address.
  if (!isHostname(domain)) {
    return NextResponse.json({ error: "domain must be a hostname" }, { status: 400 });
  }

  // For .localhost domains, check HTTP reachability instead of DNS
  const isLocal = domain.endsWith(".localhost");
  if (isLocal) {
    try {
      await fetch(`http://${domain}`, {
        method: "HEAD",
        signal: AbortSignal.timeout(3000),
        redirect: "manual",
      });
      // Any response (even 404/500) means the domain is routed
      return NextResponse.json({
        domain,
        status: "configured",
        resolves: true,
        configured: true,
        records: { a: ["127.0.0.1"], cname: [] },
      });
    } catch {
      return NextResponse.json({
        domain,
        status: "unreachable",
        resolves: false,
        configured: false,
        records: { a: [], cname: [] },
      });
    }
  }

  // External domains — check DNS records
  try {
    let aRecords: string[] = [];
    let cnameRecords: string[] = [];

    try { aRecords = await resolve4(domain); } catch { /* no A records */ }
    try { cnameRecords = await resolveCname(domain); } catch { /* no CNAME */ }

    const hasRecords = aRecords.length > 0 || cnameRecords.length > 0;

    if (!hasRecords) {
      return NextResponse.json({
        domain,
        status: "no-records",
        resolves: false,
        configured: false,
        records: { a: aRecords, cname: cnameRecords },
      });
    }

    // CNAME points to the base domain or the expected generated domain.
    const baseDomain = await getInstanceBaseDomain();
    const cnameCorrect = cnameRecords.some((r) =>
      r.endsWith(`.${baseDomain}`) || r.endsWith(`.${baseDomain}.`) ||
      (expected && (r === expected || r === `${expected}.`))
    );

    // A record points to this server's IP.
    const serverIp = await getServerIP();
    const aCorrect = serverIp ? aRecords.some((ip) => ip === serverIp) : false;

    const reach = await probeReach(domain);
    const verdict = reachVerdict(reach, aCorrect || cnameCorrect);
    const status = verdict.configured ? "configured" : verdict.reachable ? "wrong-target" : "not-responding";

    return NextResponse.json({
      domain,
      status,
      resolves: hasRecords,
      ...verdict,
      proxied: reach.proxy !== null,
      proxyProvider: reach.proxy,
      records: { a: aRecords, cname: cnameRecords },
      serverIp,
    });
  } catch {
    return NextResponse.json({
      domain,
      status: "error",
      resolves: false,
      configured: false,
      records: { a: [], cname: [] },
    });
  }
}

export const GET = withRateLimit(handleGet, { tier: "heavy", key: "get:v1/dns-check" });
