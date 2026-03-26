import { NextResponse } from "next/server";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getSslConfig } from "@/lib/system-settings";

const ISSUER_LABELS: Record<string, string> = {
  le: "Let's Encrypt",
  google: "Google Trust Services",
  zerossl: "ZeroSSL",
};

export async function POST() {
  try {
    await requireAdminAuth();
  } catch {
    return NextResponse.json({ ok: false, message: "Unauthorized" }, { status: 401 });
  }

  const config = await getSslConfig();

  // Let's Encrypt and Google Trust Services don't need extra credentials
  if (config.defaultIssuer === "le" || config.defaultIssuer === "google") {
    const acmeEmail = process.env.NEXT_PUBLIC_ACME_EMAIL;
    if (!acmeEmail) {
      return NextResponse.json({
        ok: false,
        message: `${ISSUER_LABELS[config.defaultIssuer]} requires an ACME email — set NEXT_PUBLIC_ACME_EMAIL in your environment`,
      });
    }
    return NextResponse.json({
      ok: true,
      message: `${ISSUER_LABELS[config.defaultIssuer]} is ready (ACME email: ${acmeEmail})`,
    });
  }

  // ZeroSSL requires EAB credentials
  if (config.defaultIssuer === "zerossl") {
    if (!config.zerosslEabKid || !config.zerosslEabHmac) {
      return NextResponse.json({
        ok: false,
        message: "ZeroSSL requires EAB Key ID and HMAC Key — add them above and save first",
      });
    }

    // Validate EAB credentials against the ZeroSSL API
    try {
      const res = await fetch(
        `https://api.zerossl.com/acme/eab-credentials-check?access_key=${encodeURIComponent(config.zerosslEabKid)}`,
        { method: "GET" },
      );

      if (!res.ok) {
        return NextResponse.json({
          ok: false,
          message: `ZeroSSL returned ${res.status} — check your EAB credentials`,
        });
      }

      return NextResponse.json({
        ok: true,
        message: "ZeroSSL EAB credentials are configured",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({
        ok: false,
        message: `Could not reach ZeroSSL API: ${msg}`,
      });
    }
  }

  return NextResponse.json({
    ok: false,
    message: `Unknown issuer: ${config.defaultIssuer}`,
  });
}
