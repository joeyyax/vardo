import { NextRequest, NextResponse } from "next/server";
import { resolve4, resolveCname } from "dns/promises";
import { networkInterfaces } from "os";

const BASE_DOMAIN = process.env.VARDO_BASE_DOMAIN || "localhost";

function getServerIPs(): string[] {
  // Use the configured public IP when available (production / Docker).
  // os.networkInterfaces() inside a container returns internal Docker IPs
  // (172.x.x.x) which will never match external A records.
  const serverIp = process.env.VARDO_SERVER_IP;
  if (serverIp) return [serverIp];

  // Fallback for local dev where the env var isn't set
  const ips: string[] = [];
  const nets = networkInterfaces();
  for (const interfaces of Object.values(nets)) {
    if (!interfaces) continue;
    for (const iface of interfaces) {
      if (!iface.internal && iface.family === "IPv4") {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

// GET /api/v1/dns-check?domain=example.com&expected=auto-generated.localhost
export async function GET(request: NextRequest) {
  // Require authentication
  const { getSession } = await import("@/lib/auth/session");
  const session = await getSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const domain = request.nextUrl.searchParams.get("domain");
  const expected = request.nextUrl.searchParams.get("expected");

  if (!domain) {
    return NextResponse.json({ error: "domain required" }, { status: 400 });
  }

  // For .localhost domains, check HTTP reachability instead of DNS
  const isLocal = domain.endsWith(".localhost");
  if (isLocal) {
    try {
      const res = await fetch(`http://${domain}`, {
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

    // Check if CNAME points to our base domain or the expected auto-generated domain
    const cnameCorrect = cnameRecords.some((r) =>
      r.endsWith(`.${BASE_DOMAIN}`) || r.endsWith(`.${BASE_DOMAIN}.`) ||
      (expected && (r === expected || r === `${expected}.`))
    );

    // Check if A record points to one of this server's IPs
    const serverIPs = getServerIPs();
    const aCorrect = aRecords.some((ip) => serverIPs.includes(ip));

    const configured = cnameCorrect || aCorrect;

    return NextResponse.json({
      domain,
      status: configured ? "configured" : "wrong-target",
      resolves: hasRecords,
      configured,
      records: { a: aRecords, cname: cnameRecords },
      serverIPs: serverIPs,
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
