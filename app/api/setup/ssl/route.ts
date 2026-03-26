import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getSslConfig, setSystemSetting, VALID_ISSUERS } from "@/lib/system-settings";
import { maskSecret, isMasked } from "@/lib/mask-secrets";

const ISSUER_LABELS: Record<string, string> = {
  le: "Let's Encrypt",
  google: "Google Trust Services",
  zerossl: "ZeroSSL",
};

const sslSchema = z.object({
  activeIssuers: z.array(z.enum(["le", "google", "zerossl"])).min(1, "At least one issuer must be enabled"),
  zerosslEabKid: z.string().optional(),
  zerosslEabHmac: z.string().optional(),
}).strict();

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getSslConfig();

  // ZeroSSL requires EAB credentials — only report it as configured when they exist
  const zerosslConfigured = !!(config.zerosslEabKid && config.zerosslEabHmac);

  return NextResponse.json({
    configured: true,
    activeIssuers: config.activeIssuers,
    zerosslEabKid: maskSecret(config.zerosslEabKid),
    zerosslEabHmac: maskSecret(config.zerosslEabHmac),
    zerosslConfigured,
    issuerLabels: ISSUER_LABELS,
    validIssuers: VALID_ISSUERS,
  });
}

export async function POST(request: NextRequest) {
  await requireAdminAuth(request);

  const body = await request.json();
  const parsed = sslSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { activeIssuers, zerosslEabKid, zerosslEabHmac } = parsed.data;

  // If ZeroSSL is enabled, EAB credentials are required
  if (activeIssuers.includes("zerossl")) {
    const existing = await getSslConfig();
    const resolvedKid = isMasked(zerosslEabKid) ? existing.zerosslEabKid : zerosslEabKid;
    const resolvedHmac = isMasked(zerosslEabHmac) ? existing.zerosslEabHmac : zerosslEabHmac;
    if (!resolvedKid || !resolvedHmac) {
      return NextResponse.json(
        { error: "ZeroSSL EAB Key ID and HMAC Key are required to enable ZeroSSL" },
        { status: 400 },
      );
    }
  }

  // Keep secrets the user didn't change (sentinel-prefixed values)
  const existing = await getSslConfig();

  function resolveSecret(incoming: string | undefined, existingVal: string | undefined): string | undefined {
    if (isMasked(incoming)) return existingVal;
    return incoming;
  }

  await setSystemSetting("ssl_config", JSON.stringify({
    activeIssuers,
    zerosslEabKid: resolveSecret(zerosslEabKid, existing.zerosslEabKid),
    zerosslEabHmac: resolveSecret(zerosslEabHmac, existing.zerosslEabHmac),
  }));

  return NextResponse.json({ ok: true });
}
