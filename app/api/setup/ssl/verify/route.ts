import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getSslConfig, ISSUER_LABELS, type SslIssuer } from "@/lib/system-settings";

type IssuerResult = {
  issuer: SslIssuer;
  label: string;
  ok: boolean;
  message: string;
};

async function checkIssuer(
  issuer: SslIssuer,
  acmeEmail: string | undefined,
  zerosslEabKid: string | undefined,
  zerosslEabHmac: string | undefined,
): Promise<IssuerResult> {
  const label = ISSUER_LABELS[issuer];

  if (issuer === "le" || issuer === "google") {
    if (!acmeEmail) {
      return {
        issuer,
        label,
        ok: false,
        message: `${label} requires an ACME email — set ACME_EMAIL in your environment`,
      };
    }
    return {
      issuer,
      label,
      ok: true,
      message: `${label} is ready (ACME email: ${acmeEmail})`,
    };
  }

  if (issuer === "zerossl") {
    if (!zerosslEabKid || !zerosslEabHmac) {
      return {
        issuer,
        label,
        ok: false,
        message: "ZeroSSL requires EAB Key ID and HMAC Key — add them and save first",
      };
    }

    try {
      const res = await fetch(
        `https://api.zerossl.com/acme/eab-credentials-check?access_key=${encodeURIComponent(zerosslEabKid)}`,
        { method: "GET", signal: AbortSignal.timeout(5000) },
      );

      if (!res.ok) {
        return {
          issuer,
          label,
          ok: false,
          message: `ZeroSSL returned ${res.status} — check your EAB credentials`,
        };
      }

      return {
        issuer,
        label,
        ok: true,
        message: "ZeroSSL EAB credentials are valid",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return {
        issuer,
        label,
        ok: false,
        message: `Could not reach ZeroSSL API: ${msg}`,
      };
    }
  }

  return { issuer, label, ok: false, message: `Unknown issuer: ${issuer}` };
}

export async function POST() {
  try {
    await requireAdminAuth();
  } catch {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const config = await getSslConfig();
  const acmeEmail = process.env.ACME_EMAIL;

  // DNS challenge — verify token and ACME email, skip per-issuer HTTP checks
  if (config.challengeType === "dns") {
    if (!config.dnsApiToken) {
      return NextResponse.json({
        ok: false,
        message: "DNS challenge requires a Cloudflare API token — add it above and save first",
      });
    }
    if (!acmeEmail) {
      return NextResponse.json({
        ok: false,
        message: "DNS challenge requires an ACME email — set ACME_EMAIL in your environment",
      });
    }

    // ZeroSSL + DNS-01 requires EAB credentials in addition to the API token
    if (config.activeIssuers.includes("zerossl")) {
      if (!config.zerosslEabKid || !config.zerosslEabHmac) {
        return NextResponse.json({
          ok: false,
          message: "ZeroSSL + DNS challenge requires EAB Key ID and HMAC Key — add them above and save first",
        });
      }
    }

    // CF_DNS_API_TOKEN must be set in the environment — it's what Traefik reads.
    // The token stored in the DB is for UI management only; it does not propagate
    // to Traefik automatically. Without this env var, Traefik cannot issue certs.
    const envToken = process.env.CF_DNS_API_TOKEN;
    if (!envToken) {
      return NextResponse.json({
        ok: false,
        message: "CF_DNS_API_TOKEN is not set in your environment — update .env and restart Traefik",
      });
    }

    return NextResponse.json({
      ok: true,
      message: `DNS challenge configured (Cloudflare, ACME email: ${acmeEmail}) — restart Traefik to activate`,
    });
  }

  // HTTP challenge — verify all active issuers
  const results = await Promise.all(
    config.activeIssuers.map((issuer) =>
      checkIssuer(issuer, acmeEmail, config.zerosslEabKid, config.zerosslEabHmac)
    )
  );

  const allOk = results.every((r) => r.ok);
  const failedIssuers = results.filter((r) => !r.ok);

  if (allOk) {
    const labels = results.map((r) => r.label).join(", ");
    return NextResponse.json({
      ok: true,
      message: `All active issuers are ready: ${labels}`,
      results,
    });
  }

  const failMessages = failedIssuers.map((r) => `${r.label}: ${r.message}`).join("; ");
  return NextResponse.json({
    ok: false,
    message: failMessages,
    results,
  });
}
