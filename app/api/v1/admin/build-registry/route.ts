import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getBuildRegistryConfig, parseRegistryUrl, setBuildRegistryConfig } from "@/lib/docker/build-registry";

/** GET /api/v1/admin/build-registry — the registry builds push to, without its password */
async function handleGet() {
  try {
    await requireAppAdmin();
    const config = await getBuildRegistryConfig();
    return NextResponse.json({
      configured: true,
      enabled: config !== null,
      url: config?.url ?? "",
      username: config?.username ?? "",
      hasPassword: Boolean(config?.password),
    });
  } catch (error) {
    return handleRouteError(error, "Error reading build registry settings");
  }
}

const schema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z
    .object({
      enabled: z.literal(true),
      url: z.string().trim().min(1).max(255).refine((url) => parseRegistryUrl(url) !== null, "Enter a registry host with an optional namespace, like ghcr.io/owner"),
      username: z.string().trim().max(255).default(""),
      /** Omitted or empty keeps the stored password. */
      password: z.string().max(4096).optional(),
    })
    .strict(),
]);

/** POST /api/v1/admin/build-registry — set the registry, or turn it off */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    if (!parsed.data.enabled) {
      await setBuildRegistryConfig(null);
      return NextResponse.json({ ok: true, enabled: false });
    }
    const { url, username } = parsed.data;
    const stored = await getBuildRegistryConfig();
    // A blank password keeps the stored one only for the same user on the same host.
    const sameLogin = stored?.username === username && parseRegistryUrl(stored.url)?.host === parseRegistryUrl(url)?.host;
    const password = username ? parsed.data.password || (sameLogin ? (stored?.password ?? "") : "") : "";
    if (username && !password) {
      return NextResponse.json({ error: "Enter a password or token for this username" }, { status: 400 });
    }
    await setBuildRegistryConfig({ url, username, password });
    return NextResponse.json({ ok: true, enabled: true });
  } catch (error) {
    return handleRouteError(error, "Error saving build registry settings");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/build-registry" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-build-registry" });
