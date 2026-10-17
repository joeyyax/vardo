import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { requireAppAdmin } from "@/lib/auth/admin";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  BuilderError,
  getBuildTargets,
  hostKeyFingerprints,
  resetTargetHealth,
  scanHostKey,
  setBuildTargets,
  targetDockerVersion,
} from "@/lib/docker/build-targets";

const schema = z.object({ id: z.string().min(1).max(64) }).strict();

function message(err: unknown): string {
  if (err instanceof BuilderError) return err.reason;
  const e = err as { stderr?: string; message?: string };
  return (e?.stderr?.trim() || e?.message || String(err)).split("\n").filter(Boolean).at(-1) ?? "failed";
}

/** POST /api/v1/admin/build-targets/test — pins the host key on first use, then asks the target's Docker for its version */
async function handlePost(request: NextRequest) {
  try {
    await requireAppAdmin();
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);
    const targets = await getBuildTargets();
    const index = targets.findIndex((t) => t.id === parsed.data.id);
    if (index === -1) return NextResponse.json({ error: "No such build target" }, { status: 404 });
    let target = targets[index];

    let pinned = false;
    if (!target.hostKey) {
      try {
        target = { ...target, hostKey: await scanHostKey(target.host, target.port) };
      } catch (err) {
        return NextResponse.json({ ok: false, error: `Couldn't read its SSH host key: ${message(err)}` });
      }
      targets[index] = target;
      await setBuildTargets(targets);
      pinned = true;
    }
    const fingerprints = await hostKeyFingerprints(target.hostKey!).catch(() => []);

    try {
      const version = await targetDockerVersion(target, 20_000);
      resetTargetHealth();
      return NextResponse.json({ ok: true, pinned, fingerprints, dockerVersion: version });
    } catch (err) {
      return NextResponse.json({ ok: false, pinned, fingerprints, error: message(err) });
    }
  } catch (error) {
    return handleRouteError(error, "Error testing the build target");
  }
}

export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-build-targets-test" });
