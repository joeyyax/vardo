import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { z } from "zod";
import { requireAdminAuth } from "@/lib/auth/admin";
import { getSslConfig, setSystemSetting, ISSUER_LABELS } from "@/lib/system-settings";
import { maskSecret, resolveSecret } from "@/lib/mask-secrets";

import { withRateLimit } from "@/lib/api/with-rate-limit";
import { apiError } from "@/lib/api/error-response";

const sslSchema = z.object({
  activeIssuers: z.array(z.enum(["le", "google", "zerossl"])).min(1, "At least one issuer must be enabled"),
  concurrentIssuers: z.number().int().min(1).max(3).default(1),
  challengeType: z.enum(["http", "dns"]).optional(),
  dnsProvider: z.enum(["cloudflare"]).optional(),
  dnsApiToken: z.string().optional(),
  zerosslEabKid: z.string().optional(),
  zerosslEabHmac: z.string().optional(),
}).strict();

async function handleGet(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  const config = await getSslConfig();

  // ZeroSSL counts as configured only with EAB credentials.
  const zerosslConfigured = !!(config.zerosslEabKid && config.zerosslEabHmac);

  return NextResponse.json({
    configured: true,
    activeIssuers: config.activeIssuers,
    concurrentIssuers: config.concurrentIssuers,
    challengeType: config.challengeType,
    dnsProvider: config.dnsProvider,
    dnsApiToken: maskSecret(config.dnsApiToken),
    zerosslEabKid: maskSecret(config.zerosslEabKid),
    zerosslEabHmac: maskSecret(config.zerosslEabHmac),
    zerosslConfigured,
    issuerLabels: ISSUER_LABELS,
  });
}

async function handlePost(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  await requireAdminAuth(request);

  const body = await request.json();
  const parsed = sslSchema.safeParse(body);
  if (!parsed.success) {
    return apiError.validation(parsed.error, { details: true });
  }

  const { activeIssuers, concurrentIssuers, challengeType, dnsProvider, dnsApiToken, zerosslEabKid, zerosslEabHmac } = parsed.data;

  const existing = await getSslConfig();

  const resolvedKid = resolveSecret(zerosslEabKid, existing.zerosslEabKid);
  const resolvedHmac = resolveSecret(zerosslEabHmac, existing.zerosslEabHmac);

  if (activeIssuers.includes("zerossl") && (!resolvedKid || !resolvedHmac)) {
    return NextResponse.json(
      { error: "ZeroSSL EAB Key ID and HMAC Key are required to enable ZeroSSL" },
      { status: 400 },
    );
  }

  await setSystemSetting("ssl_config", JSON.stringify({
    activeIssuers,
    concurrentIssuers,
    challengeType: challengeType ?? "http",
    dnsProvider: dnsProvider ?? "cloudflare",
    dnsApiToken: resolveSecret(dnsApiToken, existing.dnsApiToken),
    zerosslEabKid: resolvedKid,
    zerosslEabHmac: resolvedHmac,
  }));

  return NextResponse.json({ ok: true });
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "setup-ssl" });

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/ssl" });
