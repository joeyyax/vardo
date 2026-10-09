import { withRateLimit } from "@/lib/api/with-rate-limit";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import {
  ADMIN_RESOURCE_KEYS,
  SIZE_CLASSES,
  envLock,
  memoryMiB,
  sizeClass,
  validateAdminValue,
  type AdminResourceKey,
  type AdminResourceSettings,
} from "@/lib/resources/defaults";
import { currentDefaults, detectHost, hostCpuCount, loadResourceSettings, saveResourceSettings } from "@/lib/resources/host";

const updateSchema = z
  .object({
    values: z
      .object(Object.fromEntries(ADMIN_RESOURCE_KEYS.map((k) => [k, z.number().nullable().optional()])))
      .strict(),
  })
  .strict();

async function payload() {
  const { host, defaults } = await currentDefaults();
  return {
    host: host && { ...host, sizeClass: sizeClass(memoryMiB(host.memoryBytes)).name },
    hostCpus: hostCpuCount(host),
    defaults,
    sizeClasses: SIZE_CLASSES.map((c) => ({ ...c, belowGiB: Number.isFinite(c.belowGiB) ? c.belowGiB : null })),
  };
}

// GET /api/v1/admin/resources
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json(await payload());
  } catch (error) {
    return handleRouteError(error, "Error reading resource defaults");
  }
}

// PUT /api/v1/admin/resources: a number sets a value, null resets it to the rule.
async function handlePut(request: NextRequest) {
  try {
    await requireAppAdmin();

    const parsed = updateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error, { details: true });

    const changes = parsed.data.values as Partial<Record<AdminResourceKey, number | null>>;
    const hostCpus = hostCpuCount(await detectHost());
    const next: AdminResourceSettings = { ...(await loadResourceSettings()) };

    for (const [key, value] of Object.entries(changes) as [AdminResourceKey, number | null | undefined][]) {
      if (value === undefined) continue;
      if (value === null) {
        delete next[key];
        continue;
      }
      const locked = envLock(key);
      if (locked) {
        return NextResponse.json(
          { error: `${locked} is set in .env, so it wins. Change it there.`, field: key },
          { status: 409 },
        );
      }
      const problem = validateAdminValue(key, value, hostCpus);
      if (problem) return NextResponse.json({ error: problem, field: key }, { status: 400 });
      next[key] = value;
    }

    await saveResourceSettings(next);
    return NextResponse.json(await payload());
  } catch (error) {
    return handleRouteError(error, "Error saving resource defaults");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/resources" });
export const PUT = withRateLimit(handlePut, { tier: "admin", key: "admin-resources" });
