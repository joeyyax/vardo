import { NextResponse, type NextRequest } from "next/server";
import { requireAppAdmin } from "@/lib/auth/admin";
import { handleRouteError } from "@/lib/api/error-response";
import { withRateLimit } from "@/lib/api/with-rate-limit";
import {
  deleteDetachedDir,
  deleteDetachedVolume,
  NotDetachedError,
} from "@/lib/docker/detached-volumes";
import { logger } from "@/lib/logger";

const log = logger.child("admin:maintenance:detached-volumes");

type RouteParams = { params: Promise<{ name: string }> };

// DELETE /api/v1/admin/maintenance/detached-volumes/[name] — removes one detached volume.
// `?kind=dir` removes an orphaned app directory instead. Anything a live app uses is refused with 409.
async function handleDelete(request: NextRequest, { params }: RouteParams) {
  try {
    await requireAppAdmin();

    const { name } = await params;
    const kind = request.nextUrl.searchParams.get("kind") === "dir" ? "dir" : "volume";

    try {
      if (kind === "dir") await deleteDetachedDir(name);
      else await deleteDetachedVolume(name);
    } catch (err) {
      if (err instanceof NotDetachedError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      // Docker answers 409 for a volume a container still mounts.
      if (err instanceof Error && /\b409\b|in use/i.test(err.message)) {
        return NextResponse.json({ error: `"${name}" is in use.` }, { status: 409 });
      }
      throw err;
    }

    log.info(`removed detached ${kind} ${name}`);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Error removing detached volume");
  }
}

export const DELETE = withRateLimit(handleDelete, {
  tier: "critical",
  key: "maintenance:detached-volumes",
});
