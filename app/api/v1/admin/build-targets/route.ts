import { NextRequest, NextResponse } from "next/server";
import { nanoid } from "nanoid";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { getBuildRegistryConfig } from "@/lib/docker/build-registry";
import { PLACEMENT_WINDOW_DAYS, placementStats, type PlacementStats } from "@/lib/docker/build-placement-stats";
import {
  MAX_TARGET_BUILDS,
  getBuildTargets,
  hostKeyFingerprints,
  isValidTargetHost,
  isValidTargetUser,
  setBuildTargets,
  type BuildTarget,
} from "@/lib/docker/build-targets";

/** A target as the settings card sees it: no private key. */
async function publicTarget(t: BuildTarget) {
  return {
    id: t.id,
    kind: t.kind,
    name: t.name,
    host: t.host,
    port: t.port,
    user: t.user,
    maxConcurrent: t.maxConcurrent,
    hasKey: Boolean(t.privateKey),
    hostKey: t.hostKey ? await hostKeyFingerprints(t.hostKey).catch(() => ["(unreadable)"]) : null,
    ...(t.kind === "mesh" && { waiting: t.waiting ?? null }),
  };
}

/** GET /api/v1/admin/build-targets — targets in overflow order, without private keys, with this server's and each target's last 30 days of builds */
async function handleGet() {
  try {
    await requireAppAdmin();
    const [targets, stats] = await Promise.all([getBuildTargets(), placementStats().catch((): PlacementStats => ({ here: null, targets: {} }))]);
    return NextResponse.json({
      configured: true,
      registry: (await getBuildRegistryConfig()) !== null,
      statsDays: PLACEMENT_WINDOW_DAYS,
      here: stats.here,
      targets: await Promise.all(targets.map(async (t) => ({ ...(await publicTarget(t)), stats: stats.targets[t.id] ?? null }))),
    });
  } catch (error) {
    return handleRouteError(error, "Error reading build targets");
  }
}

const id = z.string().min(1).max(64);

const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("save"),
      /** Omitted adds a target. */
      id: id.optional(),
      name: z.string().trim().max(64).default(""),
      host: z.string().trim().toLowerCase().refine(isValidTargetHost, "Enter a hostname or IP address"),
      port: z.coerce.number().int().min(1).max(65535).default(22),
      user: z.string().trim().refine(isValidTargetUser, "Enter an SSH user name"),
      /** Omitted or empty keeps the stored key. */
      privateKey: z.string().max(16_384).optional(),
      maxConcurrent: z.coerce.number().int().min(0).max(MAX_TARGET_BUILDS).default(1),
    })
    .strict(),
  z.object({ action: z.literal("limit"), id, maxConcurrent: z.coerce.number().int().min(0).max(MAX_TARGET_BUILDS) }).strict(),
  z.object({ action: z.literal("remove"), id }).strict(),
  z.object({ action: z.literal("move"), id, direction: z.enum(["up", "down"]) }).strict(),
  z.object({ action: z.literal("forget-host-key"), id }).strict(),
]);

const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----/;

/** POST /api/v1/admin/build-targets — add, edit, reorder or remove a target */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    const body = parsed.data;
    const targets = await getBuildTargets();
    const index = "id" in body && body.id ? targets.findIndex((t) => t.id === body.id) : -1;
    if ("id" in body && body.id && index === -1) return NextResponse.json({ error: "No such build target" }, { status: 404 });

    const mesh = index !== -1 && targets[index].kind === "mesh";
    if (mesh && (body.action === "remove" || body.action === "forget-host-key" || body.action === "save")) {
      return NextResponse.json(
        { error: "A linked instance's target comes from the link. Set builds at a time to 0 to stop sending it builds" },
        { status: 400 },
      );
    }

    if (body.action === "limit") {
      targets[index] = { ...targets[index], maxConcurrent: body.maxConcurrent };
    } else if (body.action === "remove") {
      targets.splice(index, 1);
    } else if (body.action === "move") {
      const to = body.direction === "up" ? index - 1 : index + 1;
      if (to >= 0 && to < targets.length) [targets[index], targets[to]] = [targets[to], targets[index]];
    } else if (body.action === "forget-host-key") {
      targets[index] = { ...targets[index], hostKey: null };
    } else {
      const existing = index === -1 ? null : targets[index];
      const privateKey = body.privateKey?.trim() ? `${body.privateKey.trim()}\n` : (existing?.privateKey ?? "");
      if (!PRIVATE_KEY.test(privateKey)) {
        return NextResponse.json({ error: "Paste the SSH private key, including its BEGIN and END lines" }, { status: 400 });
      }
      // A different host or port is a different machine: its key gets pinned again.
      const sameHost = existing?.host === body.host && existing?.port === body.port;
      const next: BuildTarget = {
        id: existing?.id ?? nanoid(10),
        kind: "ssh",
        name: body.name || body.host,
        host: body.host,
        port: body.port,
        user: body.user,
        privateKey,
        hostKey: sameHost ? (existing?.hostKey ?? null) : null,
        maxConcurrent: body.maxConcurrent,
      };
      if (existing) targets[index] = next;
      else targets.push(next);
      await setBuildTargets(targets);
      return NextResponse.json({ ok: true, id: next.id });
    }
    await setBuildTargets(targets);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error saving build targets");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/build-targets" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-build-targets" });
