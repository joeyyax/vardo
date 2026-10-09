import { NextRequest, NextResponse } from "next/server";
import { setupTokenRefusal } from "@/lib/setup-token";
import { requireAdminAuth } from "@/lib/auth/admin";
import { needsSetup } from "@/lib/setup";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { describeDefaults, isAdminResourceKey, memoryMiB, sizeClass } from "@/lib/resources/defaults";
import { detectHost, hostCpuCount, loadResourceSettings } from "@/lib/resources/host";

// GET /api/setup/resources: the host's size and the per-app defaults it picked, for the setup summary.
async function handleGet(request: NextRequest) {
  const refused = await setupTokenRefusal(request);
  if (refused) return refused;
  try {
    if (!(await needsSetup())) await requireAdminAuth(request);

    const [host, admin] = await Promise.all([detectHost(), loadResourceSettings()]);
    const defaults = describeDefaults(host, hostCpuCount(host), process.env, undefined, admin)
      .filter((d) => isAdminResourceKey(d.key))
      .map(({ key, label, unit, value, source }) => ({ key, label, unit, value, source }));

    return NextResponse.json({
      host: host && { cpus: host.cpus, memoryBytes: host.memoryBytes, sizeClass: sizeClass(memoryMiB(host.memoryBytes)).name },
      defaults,
    });
  } catch (error) {
    return handleRouteError(error, "Error reading the host's size");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:setup/resources" });
