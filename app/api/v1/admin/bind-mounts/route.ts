import { NextResponse } from "next/server";
import { z } from "zod";

import { requireAppAdmin } from "@/lib/auth/admin";
import { apiError, handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import { allowBindPath, envBindRoots, getAllowedBindPaths, normalizeHostPath } from "@/lib/docker/bind-roots";
import { DENIED_MOUNT_PATHS } from "@/lib/docker/mount-paths";
import { isUnder } from "@/lib/docker/compose-root";

const allowSchema = z.object({
  path: z.string().min(1).max(4096),
});

// GET /api/v1/admin/bind-mounts — host roots untrusted apps may bind-mount from.
async function handleGet() {
  try {
    await requireAppAdmin();
    return NextResponse.json({ roots: envBindRoots(), allowed: await getAllowedBindPaths() });
  } catch (error) {
    return handleRouteError(error);
  }
}

// POST /api/v1/admin/bind-mounts — allow a host path for every untrusted app's bind mounts.
async function handlePost(request: Request) {
  try {
    await requireAppAdmin();
    const parsed = allowSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return apiError.validation(parsed.error);

    const path = normalizeHostPath(parsed.data.path);
    if (!path || path === "/") {
      return NextResponse.json({ error: "Give an absolute path other than /." }, { status: 400 });
    }
    const denied = DENIED_MOUNT_PATHS.find((d) => isUnder(path, d) || isUnder(d, path));
    if (denied) {
      return NextResponse.json({ error: `${path} overlaps ${denied}, which can never be mounted.` }, { status: 400 });
    }

    const allowed = await allowBindPath(path);
    return NextResponse.json({ allowed });
  } catch (error) {
    return handleRouteError(error, "Couldn't allow bind mount path");
  }
}

export const GET = withRateLimit(handleGet, { tier: "read", key: "get:v1/admin/bind-mounts" });
export const POST = withRateLimit(handlePost, { tier: "admin", key: "admin-bind-mounts" });
