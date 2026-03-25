import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getSslConfig, setSystemSetting } from "@/lib/system-settings";
import { maskSecret, isMasked } from "@/lib/mask-secrets";

const ISSUER_LABELS: Record<string, string> = {
  le: "Let's Encrypt",
  google: "Google Trust Services",
  zerossl: "ZeroSSL",
};

const sslSchema = z.object({
  defaultIssuer: z.enum(["le", "google", "zerossl"]),
  zerosslEabKid: z.string().optional(),
  zerosslEabHmac: z.string().optional(),
}).strict();

export async function GET(request: NextRequest) {
  await requireAdminAuth(request);

  const config = await getSslConfig();

  // Always-available issuers
  const availableIssuers = ["le", "google"];
  if (config.zerosslEabKid && config.zerosslEabHmac) {
    availableIssuers.push("zerossl");
  }

  return NextResponse.json({
    configured: true,
    defaultIssuer: config.defaultIssuer,
    zerosslEabKid: maskSecret(config.zerosslEabKid),
    zerosslEabHmac: maskSecret(config.zerosslEabHmac),
    availableIssuers,
    issuerLabels: ISSUER_LABELS,
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

  const { defaultIssuer, zerosslEabKid, zerosslEabHmac } = parsed.data;

  // Keep secrets the user didn't change (sentinel-prefixed values)
  const existing = await getSslConfig();

  function resolveSecret(incoming: string | undefined, existingVal: string | undefined): string | undefined {
    if (isMasked(incoming)) return existingVal;
    return incoming;
  }

  await setSystemSetting("ssl_config", JSON.stringify({
    defaultIssuer,
    zerosslEabKid: resolveSecret(zerosslEabKid, existing.zerosslEabKid),
    zerosslEabHmac: resolveSecret(zerosslEabHmac, existing.zerosslEabHmac),
  }));

  return NextResponse.json({ ok: true });
}
